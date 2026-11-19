//! Splits a GitHub per-file patch (hunks only, no file headers) into hunks.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Line<'a> {
    Context(&'a str),
    Added(&'a str),
    Removed(&'a str),
}

impl<'a> Line<'a> {
    pub fn text(self) -> &'a str {
        match self {
            Self::Context(t) | Self::Added(t) | Self::Removed(t) => t,
        }
    }

    pub fn is_change(self) -> bool {
        !matches!(self, Self::Context(_))
    }
}

#[derive(Debug)]
pub struct Hunk<'a> {
    pub header: &'a str,
    /// Header plus body, exactly as in the patch. Input to the hunk id.
    pub text: &'a str,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<Line<'a>>,
}

impl<'a> Hunk<'a> {
    pub fn added(&self) -> impl Iterator<Item = &'a str> + '_ {
        self.lines.iter().filter_map(|l| match l {
            Line::Added(t) => Some(*t),
            _ => None,
        })
    }

    pub fn removed(&self) -> impl Iterator<Item = &'a str> + '_ {
        self.lines.iter().filter_map(|l| match l {
            Line::Removed(t) => Some(*t),
            _ => None,
        })
    }

    /// Each line with its old and new line numbers. For added lines the old
    /// number is the next old line, and vice versa.
    pub fn numbered(&self) -> impl Iterator<Item = (Line<'a>, u32, u32)> + '_ {
        let (mut old, mut new) = (self.old_start, self.new_start);
        self.lines.iter().map(move |&line| {
            let numbers = (line, old, new);
            match line {
                Line::Context(_) => {
                    old += 1;
                    new += 1;
                }
                Line::Added(_) => new += 1,
                Line::Removed(_) => old += 1,
            }
            numbers
        })
    }
}

pub fn parse_hunks(patch: &str) -> Vec<Hunk<'_>> {
    let mut starts: Vec<usize> = Vec::new();
    let mut offset = 0;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@ ") {
            starts.push(offset);
        }
        offset += line.len();
    }

    starts
        .iter()
        .enumerate()
        .filter_map(|(i, &start)| {
            let end = starts.get(i + 1).copied().unwrap_or(patch.len());
            parse_hunk(&patch[start..end])
        })
        .collect()
}

fn parse_hunk(text: &str) -> Option<Hunk<'_>> {
    let mut raw_lines = text.split_inclusive('\n');
    let header = raw_lines.next()?.trim_end_matches(['\n', '\r']);
    let ranges = header.strip_prefix("@@ ")?.split(" @@").next()?;
    let mut parts = ranges.split(' ');
    let (old_start, old_lines) = parse_range(parts.next()?.strip_prefix('-')?)?;
    let (new_start, new_lines) = parse_range(parts.next()?.strip_prefix('+')?)?;

    let lines = raw_lines
        .filter_map(|raw| {
            let raw = raw.trim_end_matches(['\n', '\r']);
            match raw.as_bytes().first() {
                Some(b'+') => Some(Line::Added(&raw[1..])),
                Some(b'-') => Some(Line::Removed(&raw[1..])),
                Some(b' ') => Some(Line::Context(&raw[1..])),
                // "\ No newline at end of file", or a blank context line
                // whose leading space was stripped.
                Some(b'\\') => None,
                None => Some(Line::Context("")),
                _ => None,
            }
        })
        .collect();

    Some(Hunk {
        header,
        text,
        old_start,
        old_lines,
        new_start,
        new_lines,
        lines,
    })
}

fn parse_range(range: &str) -> Option<(u32, u32)> {
    match range.split_once(',') {
        Some((start, len)) => Some((start.parse().ok()?, len.parse().ok()?)),
        None => Some((range.parse().ok()?, 1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_hunks() {
        let patch = "@@ -1,2 +1,3 @@ fn main()\n a\n+b\n c\n@@ -10 +11 @@\n-x\n+y\n\\ No newline at end of file";
        let hunks = parse_hunks(patch);
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].header, "@@ -1,2 +1,3 @@ fn main()");
        assert_eq!(
            (
                hunks[0].old_start,
                hunks[0].old_lines,
                hunks[0].new_start,
                hunks[0].new_lines
            ),
            (1, 2, 1, 3)
        );
        assert_eq!(
            hunks[0].lines,
            vec![Line::Context("a"), Line::Added("b"), Line::Context("c")]
        );
        assert_eq!((hunks[1].old_start, hunks[1].old_lines), (10, 1));
        assert_eq!(hunks[1].lines, vec![Line::Removed("x"), Line::Added("y")]);
        assert!(hunks[1].text.starts_with("@@ -10 +11 @@"));
    }

    #[test]
    fn numbers_lines() {
        let hunks = parse_hunks("@@ -5,2 +7,2 @@\n a\n-b\n+c\n");
        let numbered: Vec<_> = hunks[0].numbered().map(|(_, o, n)| (o, n)).collect();
        assert_eq!(numbered, vec![(5, 7), (6, 8), (7, 8)]);
    }
}
