//! Server-side encryption at rest for secrets the server must be able to use
//! itself (GitHub tokens). Inference credentials do NOT go through here: they
//! live in the client-encrypted passkey vault, which the server cannot open.

use aes_gcm::{
    Aes256Gcm, KeyInit,
    aead::{Aead, Nonce},
};
use rand::RngExt;
use sha2::{Digest, Sha256};

pub struct Cipher(Aes256Gcm);

const NONCE_LEN: usize = 12;

impl Cipher {
    pub fn new(key: &[u8; 32]) -> Self {
        Self(Aes256Gcm::new(key.into()))
    }

    /// Returns `nonce || ciphertext`.
    pub fn encrypt(&self, plaintext: &[u8]) -> Vec<u8> {
        let nonce_bytes: [u8; NONCE_LEN] = rand::rng().random();
        let nonce = Nonce::<Aes256Gcm>::from(nonce_bytes);
        let ciphertext = self.0.encrypt(&nonce, plaintext).expect("aes-gcm encrypt");
        [nonce_bytes.as_slice(), &ciphertext].concat()
    }

    pub fn decrypt(&self, blob: &[u8]) -> Option<Vec<u8>> {
        let (nonce_bytes, ciphertext) = blob.split_at_checked(NONCE_LEN)?;
        let nonce = Nonce::<Aes256Gcm>::try_from(nonce_bytes).ok()?;
        self.0.decrypt(&nonce, ciphertext).ok()
    }
}

pub fn random_token() -> String {
    let bytes: [u8; 32] = rand::rng().random();
    hex::encode(bytes)
}

pub fn sha256(input: &str) -> Vec<u8> {
    Sha256::digest(input.as_bytes()).to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let cipher = Cipher::new(&[7; 32]);
        let blob = cipher.encrypt(b"gho_secret");
        assert_eq!(cipher.decrypt(&blob).as_deref(), Some(b"gho_secret".as_slice()));
        assert!(Cipher::new(&[8; 32]).decrypt(&blob).is_none());
    }
}
