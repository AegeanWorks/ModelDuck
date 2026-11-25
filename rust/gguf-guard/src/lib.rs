//! Bounded GGUF v2/v3 header parser, shared by the CLI and the in-process
//! Node addon. No dependencies: every count and length is checked against the
//! remaining file before it is trusted.

#![allow(non_camel_case_types)]

use std::ffi::c_char;
use std::fs::File;
use std::io::{BufReader, Read};

const STRING: u32 = 8;
const ARRAY: u32 = 9;
const MAX_ARRAY_DEPTH: u32 = 1;
const MAX_TENSOR_DIMS: u32 = 4;
const MIN_KV_BYTES: u128 = 8 + 4 + 1;
const MIN_TENSOR_BYTES: u128 = 8 + 4 + 8 + 4 + 8;
const MIN_ARRAY_BYTES: u128 = 4 + 8;

fn scalar_bytes(kind: u32) -> Option<u128> {
    match kind {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4 | 5 | 6 => Some(4),
        10 | 11 | 12 => Some(8),
        _ => None,
    }
}

struct Reader {
    inner: BufReader<File>,
    size: u64,
    position: u64,
}

impl Reader {
    fn remaining(&self) -> u128 {
        (self.size - self.position) as u128
    }

    fn need(&self, bytes: u128, what: &str) -> Result<(), String> {
        if bytes > self.remaining() {
            return Err(format!("The header ends inside {what}."));
        }
        Ok(())
    }

    fn u32(&mut self, what: &str) -> Result<u32, String> {
        self.need(4, what)?;
        let mut buf = [0u8; 4];
        self.inner.read_exact(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        self.position += 4;
        Ok(u32::from_le_bytes(buf))
    }

    fn u64(&mut self, what: &str) -> Result<u64, String> {
        self.need(8, what)?;
        let mut buf = [0u8; 8];
        self.inner.read_exact(&mut buf).map_err(|e| format!("read failed: {e}"))?;
        self.position += 8;
        Ok(u64::from_le_bytes(buf))
    }

    fn skip(&mut self, bytes: u128, what: &str) -> Result<(), String> {
        self.need(bytes, what)?;
        // seek_relative consumes bytes already in the BufReader without a
        // syscall and seeks once for a span larger than its buffer. The old
        // scratch read copied every vocabulary/template byte just to advance.
        let offset = i64::try_from(bytes).map_err(|_| format!("{what} is too large to skip."))?;
        self.inner.seek_relative(offset).map_err(|e| format!("seek failed: {e}"))?;
        self.position += bytes as u64;
        Ok(())
    }

    fn bound(&self, count: u64, min_bytes: u128, what: &str) -> Result<(), String> {
        let claimed = (count as u128).checked_mul(min_bytes).ok_or_else(|| {
            format!("The header claims {count} {what}, more than the file could hold.")
        })?;
        if claimed > self.remaining() {
            return Err(format!("The header claims {count} {what}, more than the file could hold."));
        }
        Ok(())
    }

    fn string(&mut self, what: &str) -> Result<(), String> {
        let length = self.u64("a string length")?;
        self.skip(length as u128, what)
    }
}

// The native result is used only for structurally valid headers. A rejection
// falls back to the JavaScript guard, which builds the precise Why/Fix text,
// so these bounds can use static labels instead of allocating a message per token.
fn skip_value(reader: &mut Reader, kind: u32, depth: u32) -> Result<(), String> {
    if let Some(bytes) = scalar_bytes(kind) {
        return reader.skip(bytes, "a metadata value");
    }
    if kind == STRING {
        return reader.string("a metadata value");
    }
    if kind != ARRAY {
        return Err("A metadata key has an unknown value type.".into());
    }
    if depth >= MAX_ARRAY_DEPTH {
        return Err("An array nests arrays inside arrays.".into());
    }
    let element_type = reader.u32("an array type")?;
    let count = reader.u64("an array length")?;
    if let Some(bytes) = scalar_bytes(element_type) {
        return reader.skip((count as u128) * bytes, "an array");
    }
    if element_type == STRING {
        reader.bound(count, 8, "strings in an array")?;
        for _ in 0..count {
            reader.string("a string in an array")?;
        }
        return Ok(());
    }
    reader.bound(count, MIN_ARRAY_BYTES, "elements in an array")?;
    for _ in 0..count {
        skip_value(reader, element_type, depth + 1)?;
    }
    Ok(())
}

/// The result is `(version, tensorCount, kvCount)` for a structurally valid v2/v3 header.
pub fn inspect(path: &str) -> Result<(u32, u64, u64), String> {
    let file = File::open(path).map_err(|e| format!("cannot open file: {e}"))?;
    let size = file.metadata().map_err(|e| format!("cannot stat file: {e}"))?.len();
    let mut reader = Reader { inner: BufReader::new(file), size, position: 0 };

    let magic = reader.u32("the signature")?;
    if magic != 0x4655_4747 {
        return Err("The file does not begin with the GGUF signature.".into());
    }
    let version = reader.u32("the version")?;
    if version != 2 && version != 3 {
        return Err(format!("GGUF version {version} is not supported; ModelDuck reads versions 2 and 3."));
    }
    let tensor_count = reader.u64("the tensor count")?;
    let kv_count = reader.u64("the metadata count")?;
    reader.bound(kv_count, MIN_KV_BYTES, "metadata entries")?;
    reader.bound(tensor_count, MIN_TENSOR_BYTES, "tensors")?;

    for _ in 0..kv_count {
        reader.string("a metadata key")?;
        let kind = reader.u32("a metadata value type")?;
        skip_value(&mut reader, kind, 0)?;
    }
    reader.bound(tensor_count, MIN_TENSOR_BYTES, "tensors")?;
    for _ in 0..tensor_count {
        reader.string("a tensor name")?;
        let dims = reader.u32("the dimensions of a tensor")?;
        if dims < 1 || dims > MAX_TENSOR_DIMS {
            return Err(format!("A tensor claims {dims} dimensions; GGUF allows 1 to {MAX_TENSOR_DIMS}."));
        }
        reader.skip((dims as u128) * 8 + 4, "the shape of a tensor")?;
        let offset = reader.u64("a tensor offset")?;
        if offset >= size {
            return Err("A tensor points past the end of the file.".into());
        }
    }
    Ok((version, tensor_count, kv_count))
}

// --- Minimal N-API surface (no crate dependencies) ---------------------------------------------

#[repr(C)]
pub struct napi_env__ { _private: [u8; 0] }
#[repr(C)]
pub struct napi_value__ { _private: [u8; 0] }
#[repr(C)]
pub struct napi_callback_info__ { _private: [u8; 0] }

pub type napi_env = *mut napi_env__;
pub type napi_value = *mut napi_value__;
pub type napi_callback_info = *mut napi_callback_info__;
type NapiCallback = unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value;

#[link(name = "node")]
extern "C" {
    fn napi_create_function(env: napi_env, name: *const c_char, length: usize,
        cb: Option<NapiCallback>, data: *mut std::ffi::c_void, result: *mut napi_value) -> i32;
    fn napi_get_cb_info(env: napi_env, info: napi_callback_info, argc: *mut usize,
        argv: *mut napi_value, this_arg: *mut napi_value, data: *mut *mut std::ffi::c_void) -> i32;
    fn napi_get_value_string_utf8(env: napi_env, value: napi_value, buf: *mut c_char,
        bufsize: usize, result: *mut usize) -> i32;
    fn napi_create_object(env: napi_env, result: *mut napi_value) -> i32;
    fn napi_create_int64(env: napi_env, value: i64, result: *mut napi_value) -> i32;
    fn napi_set_named_property(env: napi_env, object: napi_value, name: *const c_char,
        value: napi_value) -> i32;
    fn napi_throw_error(env: napi_env, code: *const c_char, message: *const c_char) -> i32;
    fn napi_get_undefined(env: napi_env, result: *mut napi_value) -> i32;
}

unsafe extern "C" fn inspect_js(env: napi_env, info: napi_callback_info) -> napi_value {
    let mut argc: usize = 1;
    let mut argv: [napi_value; 1] = [std::ptr::null_mut()];
    let ok = napi_get_cb_info(env, info, &mut argc, argv.as_mut_ptr(),
        std::ptr::null_mut(), std::ptr::null_mut());
    let mut undefined = std::ptr::null_mut();
    napi_get_undefined(env, &mut undefined);
    if ok != 0 || argc == 0 {
        napi_throw_error(env, std::ptr::null(), c"gguf-guard needs a file path".as_ptr());
        return undefined;
    }
    let mut length: usize = 0;
    napi_get_value_string_utf8(env, argv[0], std::ptr::null_mut(), 0, &mut length);
    let mut bytes = vec![0u8; length + 1];
    napi_get_value_string_utf8(env, argv[0], bytes.as_mut_ptr() as *mut c_char,
        bytes.len(), &mut length);
    bytes.truncate(length);
    let path = String::from_utf8_lossy(&bytes);
    match inspect(&path) {
        Ok((version, tensors, kvs)) => {
            let mut object = std::ptr::null_mut();
            if napi_create_object(env, &mut object) != 0 { return undefined; }
            for (name, value) in [("version\0", version as i64),
                ("tensorCount\0", tensors as i64), ("kvCount\0", kvs as i64)] {
                let mut number = std::ptr::null_mut();
                if napi_create_int64(env, value, &mut number) != 0 { return undefined; }
                if napi_set_named_property(env, object, name.as_ptr() as *const c_char, number) != 0 {
                    return undefined;
                }
            }
            object
        }
        Err(reason) => {
            let message = std::ffi::CString::new(reason).unwrap_or_else(|_| c"invalid GGUF header".into());
            napi_throw_error(env, c"gguf_header_rejected".as_ptr(), message.as_ptr());
            undefined
        }
    }
}

#[no_mangle]
pub extern "C" fn napi_register_module_v1(env: napi_env, exports: napi_value) -> napi_value {
    unsafe {
        let mut function = std::ptr::null_mut();
        let name = c"inspectGguf";
        let ok = napi_create_function(env, name.as_ptr(), name.to_bytes().len() - 1,
            Some(inspect_js), std::ptr::null_mut(), &mut function);
        if ok == 0 {
            napi_set_named_property(env, exports, c"inspectGguf".as_ptr(), function);
        }
    }
    exports
}
