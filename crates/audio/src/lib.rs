use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi::{Env, Error, Result, Task};
use napi_derive::napi;

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
