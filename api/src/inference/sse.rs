//! Minimal server-sent events parser: yields the `data` of each event.

#[derive(Default)]
pub struct Parser {
    // Bytes, not a String: a chunk can end in the middle of a UTF-8 sequence.
    buffer: Vec<u8>,
}

impl Parser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend(chunk.iter().filter(|&&b| b != b'\r'));

        let mut events = Vec::new();
        while let Some(end) = self.buffer.windows(2).position(|w| w == b"\n\n") {
            let raw: Vec<u8> = self.buffer.drain(..end + 2).collect();
            let raw = String::from_utf8_lossy(&raw);
            let data: Vec<&str> = raw
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|d| d.strip_prefix(' ').unwrap_or(d))
                .collect();
            if !data.is_empty() && data != ["[DONE]"] {
                events.push(data.join("\n"));
            }
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_events_across_chunks() {
        let mut p = Parser::default();
        assert!(p.push(b"event: a\ndata: {\"x\"").is_empty());
        assert_eq!(p.push(b":1}\n\ndata: 2\r\n\r\n"), vec!["{\"x\":1}", "2"]);
        assert!(p.push(b"data: [DONE]\n\n").is_empty());
    }

    #[test]
    fn keeps_multibyte_characters_split_across_chunks() {
        let mut p = Parser::default();
        let bytes = "data: é\n\n".as_bytes();
        assert!(p.push(&bytes[..7]).is_empty());
        assert_eq!(p.push(&bytes[7..]), vec!["é"]);
    }
}
