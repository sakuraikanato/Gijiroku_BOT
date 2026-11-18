use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Task};
use napi_derive::napi;
use std::sync::Arc;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[napi]
pub fn audio_probe() -> u32 {
    42
}

pub struct FirstByte(Vec<u8>);

impl Task for FirstByte {
    type Output = u8;
    type JsValue = u32;

    fn compute(&mut self) -> Result<u8> {
        self.0
            .first()
            .copied()
            .ok_or_else(|| Error::from_reason("empty buffer"))
    }

    fn resolve(&mut self, _env: Env, output: u8) -> Result<u32> {
        Ok(u32::from(output))
    }
}

#[napi]
pub fn audio_buffer_probe(input: Buffer) -> AsyncTask<FirstByte> {
    AsyncTask::new(FirstByte(input.to_vec()))
}

const SAMPLE_RATE: usize = 16_000;
const MAX_SECONDS: usize = 12;
const MAX_PACKETS: usize = 600;
const MAX_PACKET_BYTES: usize = 512 * 1024;

fn decode_packets(packets: &[Vec<u8>]) -> std::result::Result<Vec<f32>, String> {
    if packets.is_empty() || packets.len() > MAX_PACKETS {
        return Err("invalid Opus segment packet count".into());
    }
    if packets.iter().map(Vec::len).sum::<usize>() > MAX_PACKET_BYTES {
        return Err("Opus segment byte limit exceeded".into());
    }
    let mut decoder = opus::Decoder::new(48_000, opus::Channels::Stereo)
        .map_err(|_| "Opus decoder initialization failed")?;
    let mut stereo = vec![0.0_f32; 5760 * 2];
    let mut pcm = Vec::new();
    for packet in packets {
        if packet.is_empty() {
            return Err("empty Opus packet".into());
        }
        let frames = decoder
            .decode_float(packet, &mut stereo, false)
            .map_err(|_| "invalid Opus packet")?;
        pcm.extend(
            stereo[..frames * 2]
                .chunks_exact(6)
                .map(|frame| frame.iter().sum::<f32>() / 6.0),
        );
        if pcm.len() > SAMPLE_RATE * MAX_SECONDS {
            return Err("Opus segment duration limit exceeded".into());
        }
    }
    Ok(pcm)
}

fn voiced_range(pcm: &[f32], threshold: f32) -> Option<std::ops::Range<usize>> {
    const FRAME: usize = SAMPLE_RATE / 50;
    let active: Vec<usize> = pcm
        .chunks(FRAME)
        .enumerate()
        .filter_map(|(index, frame)| {
            let power =
                frame.iter().map(|sample| sample * sample).sum::<f32>() / frame.len() as f32;
            (power.sqrt() >= threshold).then_some(index)
        })
        .collect();
    if active.len() < 4 {
        return None;
    }
    let first = active.first().copied()?;
    let last = active.last().copied()?;
    let padding = SAMPLE_RATE / 5;
    Some(
        first.saturating_mul(FRAME).saturating_sub(padding)
            ..((last + 1) * FRAME + padding).min(pcm.len()),
    )
}

#[napi]
pub struct Recognizer {
    context: Arc<WhisperContext>,
    language: String,
    threshold: f32,
}

#[napi]
impl Recognizer {
    #[napi(constructor)]
    pub fn new(model_path: String, language: String, vad_threshold: f64) -> Result<Self> {
        // Native debug logs can contain recognized tokens. Keep them out of stdout/stderr.
        whisper_rs::install_logging_hooks();
        if !(0.0..=1.0).contains(&vad_threshold) || vad_threshold == 0.0 {
            return Err(Error::from_reason("VAD threshold must be between 0 and 1"));
        }
        if language != "auto" && whisper_rs::get_lang_id(&language).is_none() {
            return Err(Error::from_reason("unsupported recognition language"));
        }
        let mut parameters = WhisperContextParameters::default();
        parameters.use_gpu(false);
        let context = WhisperContext::new_with_params(&model_path, parameters)
            .map_err(|_| Error::from_reason("Whisper model could not be loaded"))?;
        Ok(Self {
            context: Arc::new(context),
            language,
            threshold: vad_threshold as f32,
        })
    }

    #[napi]
    pub fn transcribe_opus(&self, packets: Vec<Buffer>) -> AsyncTask<Transcription> {
        AsyncTask::new(Transcription {
            context: Arc::clone(&self.context),
            language: self.language.clone(),
            threshold: self.threshold,
            source: AudioSource::Opus(packets.iter().map(|packet| packet.to_vec()).collect()),
        })
    }

    #[napi]
    pub fn transcribe_pcm(&self, pcm: Buffer) -> AsyncTask<Transcription> {
        AsyncTask::new(Transcription {
            context: Arc::clone(&self.context),
            language: self.language.clone(),
            threshold: self.threshold,
            source: AudioSource::Pcm(pcm.to_vec()),
        })
    }
}

enum AudioSource {
    Opus(Vec<Vec<u8>>),
    Pcm(Vec<u8>),
}

pub struct Transcription {
    context: Arc<WhisperContext>,
    language: String,
    threshold: f32,
    source: AudioSource,
}

impl Task for Transcription {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<String> {
        let pcm = match &self.source {
            AudioSource::Opus(packets) => decode_packets(packets).map_err(Error::from_reason)?,
            AudioSource::Pcm(bytes) => {
                if bytes.is_empty()
                    || bytes.len() % 2 != 0
                    || bytes.len() > SAMPLE_RATE * MAX_SECONDS * 2
                {
                    return Err(Error::from_reason("invalid 16 kHz PCM segment"));
                }
                bytes
                    .chunks_exact(2)
                    .map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0)
                    .collect()
            }
        };
        let Some(range) = voiced_range(&pcm, self.threshold) else {
            return Ok(String::new());
        };
        let mut samples = pcm[range].to_vec();
        // whisper.cpp requires at least one second of input.
        samples.resize(samples.len().max(SAMPLE_RATE), 0.0);
        let mut parameters = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        parameters.set_n_threads(2);
        parameters.set_no_context(true);
        parameters.set_language((self.language != "auto").then_some(self.language.as_str()));
        parameters.set_translate(false);
        parameters.set_print_special(false);
        parameters.set_print_progress(false);
        parameters.set_print_realtime(false);
        parameters.set_print_timestamps(false);
        parameters.set_suppress_blank(true);
        parameters.set_suppress_nst(true);
        let mut state = self
            .context
            .create_state()
            .map_err(|_| Error::from_reason("Whisper state initialization failed"))?;
        state
            .full(parameters, &samples)
            .map_err(|_| Error::from_reason("Whisper recognition failed"))?;
        let mut text = String::new();
        for index in 0..state.full_n_segments() {
            let segment = state
                .get_segment(index)
                .ok_or_else(|| Error::from_reason("Whisper returned an invalid segment"))?;
            text.push_str(
                &segment
                    .to_str_lossy()
                    .map_err(|_| Error::from_reason("Whisper returned invalid text"))?,
            );
        }
        Ok(text.trim().to_owned())
    }

    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vad_rejects_silence_and_short_noise() {
        assert!(voiced_range(&vec![0.0; SAMPLE_RATE], 0.008).is_none());
        assert!(voiced_range(&vec![0.4; 320], 0.008).is_none());
        let mut pcm = vec![0.0; SAMPLE_RATE];
        pcm[4000..8000].fill(0.2);
        let range = voiced_range(&pcm, 0.008).expect("voice");
        assert!(range.start <= 4000);
        assert!(range.end >= 8000);
    }

    #[test]
    fn opus_decodes_stereo_into_16khz_mono() {
        let mut encoder =
            opus::Encoder::new(48_000, opus::Channels::Stereo, opus::Application::Voip).unwrap();
        let frame: Vec<f32> = (0..960)
            .flat_map(|index| {
                let sample = (index as f32 * std::f32::consts::TAU * 440.0 / 48_000.0).sin() * 0.3;
                [sample, sample]
            })
            .collect();
        let mut packet = vec![0; 4000];
        let size = encoder.encode_float(&frame, &mut packet).unwrap();
        packet.truncate(size);
        let pcm = decode_packets(&vec![packet; 10]).unwrap();
        assert_eq!(pcm.len(), 3200);
        assert!(voiced_range(&pcm, 0.008).is_some());
    }

    #[test]
    fn opus_rejects_invalid_and_excessive_input() {
        assert!(decode_packets(&[]).is_err());
        assert!(decode_packets(&[vec![]]).is_err());
        assert!(decode_packets(&vec![vec![0xFF]; MAX_PACKETS + 1]).is_err());
        assert!(decode_packets(&[vec![0; MAX_PACKET_BYTES + 1]]).is_err());
    }
}
