//! Per-machine registration state. Holds no tokens: the client id issued by
//! dynamic registration and the stable host id must be reused on every
//! sign-in from this machine.

use std::{fs, io::Write, path::PathBuf};

use anyhow::Context;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct HostState {
    pub ext_agent_host_id: String,
    /// `oaiapp_...`, once the first sign-in has registered this machine.
    pub client_id: Option<String>,
}

impl HostState {
    fn path() -> anyhow::Result<PathBuf> {
        Ok(dirs::config_dir()
            .context("no config directory on this system")?
            .join("loupe")
            .join("gateway.json"))
    }

    pub fn load_or_create() -> anyhow::Result<Self> {
        let path = Self::path()?;
        match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).with_context(|| format!("{} is corrupt", path.display())),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let state = Self {
                    ext_agent_host_id: format!("urn:uuid:{}", uuid::Uuid::new_v4()),
                    client_id: None,
                };
                state.save()?;
                Ok(state)
            }
            Err(err) => Err(err).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Atomic, owner-only write.
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::path()?;
        let dir = path.parent().expect("path has a parent");
        fs::create_dir_all(dir)?;
        let tmp = path.with_extension("json.tmp");
        {
            let mut options = fs::OpenOptions::new();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
            let mut file = options.open(&tmp)?;
            file.write_all(&serde_json::to_vec_pretty(self)?)?;
            file.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        Ok(())
    }

    pub fn reset() -> anyhow::Result<()> {
        match fs::remove_file(Self::path()?) {
            Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
            _ => Ok(()),
        }
    }
}
