use std::fs;
use std::io;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = fs::read("models/audio-fixture.wav")?;
    let mut offset = 12;
    let mut pcm = None;
    while offset + 8 <= bytes.len() {
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into()?) as usize;
        if &bytes[offset..offset + 4] == b"data" {
            pcm = Some(&bytes[offset + 8..offset + 8 + length]);
            break;
        }
        offset += 8 + length + length % 2;
    }
    let samples: Vec<i16> = pcm
        .ok_or(io::Error::other("missing WAV data"))?
        .chunks_exact(2)
        .map(|value| i16::from_le_bytes([value[0], value[1]]))
        .collect();
    let mut encoder = opus::Encoder::new(16_000, opus::Channels::Mono, opus::Application::Voip)?;
    let mut encoded = Vec::new();
    for frame in samples.chunks(320) {
        let mut padded = [0_i16; 320];
        padded[..frame.len()].copy_from_slice(frame);
        let mut packet = [0_u8; 4000];
        let length = encoder.encode(&padded, &mut packet)?;
        encoded.extend_from_slice(&(length as u32).to_le_bytes());
        encoded.extend_from_slice(&packet[..length]);
    }
    fs::write("models/audio-fixture.opuspackets", encoded)?;
    Ok(())
}
