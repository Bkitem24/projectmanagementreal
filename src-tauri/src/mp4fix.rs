// Fragmented-MP4 -> regular-MP4 converter for Meetings recordings (Round 39).
//
// Chromium's MediaRecorder can only write FRAGMENTED MP4: an empty index up
// front (moov with empty sample tables + mvex), then many moof+mdat pairs.
// VLC/ffmpeg cope; Windows' own Media Player treats it like a live stream.
// This builds the full index the fragments describe (every sample's size,
// duration, keyframe flag and file position) as a normal moov, appends it at
// the END of the file, then relabels the old moov/moof/mfra boxes as 'free'
// (the standard "ignore this box" type). Media data never moves: a multi-GB
// recording converts in seconds, needs no extra disk space, no re-encode.
// Any parse problem -> Err before a single byte is written.
// See docs/superpowers/plans/2026-09-25-round-39-meetings-audio-mp4.md.
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

#[derive(Serialize, Debug)]
pub struct DefragReport { pub fragments: usize, pub samples: usize, pub duration_secs: f64 }

fn be32(b: &[u8], p: usize) -> Result<u32, String> {
    b.get(p..p + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])).ok_or_else(|| format!("read past end of box at {}", p))
}
fn be64(b: &[u8], p: usize) -> Result<u64, String> {
    b.get(p..p + 8).map(|s| { let mut a = [0u8; 8]; a.copy_from_slice(s); u64::from_be_bytes(a) }).ok_or_else(|| format!("read past end of box at {}", p))
}
fn version(b: &[u8]) -> Result<u8, String> { b.first().copied().ok_or_else(|| "empty full box".to_string()) }

#[derive(Clone, Copy, Debug)]
struct BoxHdr { typ: [u8; 4], start: u64, header_len: u64, size: u64 }

fn read_hdr<R: Read + Seek>(f: &mut R, pos: u64, file_len: u64) -> Result<Option<BoxHdr>, String> {
    if pos == file_len { return Ok(None); }
    if pos + 8 > file_len { return Err(format!("{} stray bytes at end of file (truncated recording?)", file_len - pos)); }
    f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
    let mut h = [0u8; 8];
    f.read_exact(&mut h).map_err(|e| e.to_string())?;
    let size32 = u32::from_be_bytes([h[0], h[1], h[2], h[3]]);
    let typ = [h[4], h[5], h[6], h[7]];
    let (size, header_len) = match size32 {
        0 => (file_len - pos, 8),
        1 => { let mut b = [0u8; 8]; f.read_exact(&mut b).map_err(|e| e.to_string())?; (u64::from_be_bytes(b), 16) }
        n => (n as u64, 8),
    };
    if size < header_len || pos + size > file_len {
        return Err(format!("box '{}' at {} runs past end of file (truncated recording?)", String::from_utf8_lossy(&typ), pos));
    }
    Ok(Some(BoxHdr { typ, start: pos, header_len, size }))
}

fn read_body<R: Read + Seek>(f: &mut R, h: &BoxHdr) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; (h.size - h.header_len) as usize];
    f.seek(SeekFrom::Start(h.start + h.header_len)).map_err(|e| e.to_string())?;
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

struct Child<'a> { typ: [u8; 4], body: &'a [u8], raw: &'a [u8] }

fn children(buf: &[u8]) -> Result<Vec<Child<'_>>, String> {
    let mut out = Vec::new();
    let mut p = 0usize;
    while p + 8 <= buf.len() {
        let size32 = be32(buf, p)? as usize;
        let typ = [buf[p + 4], buf[p + 5], buf[p + 6], buf[p + 7]];
        let (size, hl) = match size32 { 0 => (buf.len() - p, 8), 1 => (be64(buf, p + 8)? as usize, 16), n => (n, 8) };
        if size < hl || p + size > buf.len() {
            return Err(format!("malformed '{}' box at {}", String::from_utf8_lossy(&typ), p));
        }
        out.push(Child { typ, body: &buf[p + hl..p + size], raw: &buf[p..p + size] });
        p += size;
    }
    Ok(out)
}

fn find<'a>(kids: &'a [Child<'a>], typ: &[u8; 4]) -> Result<&'a Child<'a>, String> {
    kids.iter().find(|k| &k.typ == typ).ok_or_else(|| format!("missing '{}' box", String::from_utf8_lossy(typ)))
}

fn make_box(typ: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(body.len() + 8);
    v.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    v.extend_from_slice(typ);
    v.extend_from_slice(body);
    v
}
fn make_full_box(typ: &[u8; 4], ver: u8, flags: u32, body: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(body.len() + 4);
    b.push(ver);
    b.extend_from_slice(&flags.to_be_bytes()[1..]);
    b.extend_from_slice(body);
    make_box(typ, &b)
}

#[derive(Clone, Copy)]
struct Sample { size: u32, duration: u32, flags: u32, cto: i32 }

struct Track {
    id: u32,
    media_timescale: u32,
    trex_duration: u32,
    trex_size: u32,
    trex_flags: u32,
    samples: Vec<Sample>,
    chunks: Vec<(u64, u32)>, // (absolute file offset, sample count) - one per trun
    first_dts: Option<u64>,
    next_dts: u64,
}

fn track_id_and_timescale(trak_body: &[u8]) -> Result<(u32, u32), String> {
    let kids = children(trak_body)?;
    let tkhd = find(&kids, b"tkhd")?;
    let id = if version(tkhd.body)? == 1 { be32(tkhd.body, 20)? } else { be32(tkhd.body, 12)? };
    let mdia = find(&kids, b"mdia")?;
    let mk = children(mdia.body)?;
    let mdhd = find(&mk, b"mdhd")?;
    let ts = if version(mdhd.body)? == 1 { be32(mdhd.body, 20)? } else { be32(mdhd.body, 12)? };
    if ts == 0 { return Err(format!("track {} has timescale 0", id)); }
    Ok((id, ts))
}

fn parse_moof(moof_start: u64, body: &[u8], tracks: &mut [Track]) -> Result<(), String> {
    let mut prev_traf_end: Option<u64> = None;
    for traf in children(body)?.iter().filter(|c| &c.typ == b"traf") {
        let kids = children(traf.body)?;
        let tfhd = find(&kids, b"tfhd")?.body;
        let flags = be32(tfhd, 0)? & 0x00FF_FFFF;
        let track_id = be32(tfhd, 4)?;
        let mut p = 8;
        let mut explicit_base = None;
        if flags & 0x1 != 0 { explicit_base = Some(be64(tfhd, p)?); p += 8; }
        if flags & 0x2 != 0 { p += 4; }
        let mut def_dur = None; if flags & 0x8 != 0 { def_dur = Some(be32(tfhd, p)?); p += 4; }
        let mut def_size = None; if flags & 0x10 != 0 { def_size = Some(be32(tfhd, p)?); p += 4; }
        let mut def_flags = None; if flags & 0x20 != 0 { def_flags = Some(be32(tfhd, p)?); }
        // ISO 14496-12 8.8.7: explicit base > default-base-is-moof > (first traf: moof start, later trafs: end of previous traf's data)
        let base = match explicit_base {
            Some(b) => b,
            None if flags & 0x2_0000 != 0 => moof_start,
            None => prev_traf_end.unwrap_or(moof_start),
        };
        let t = tracks.iter_mut().find(|t| t.id == track_id).ok_or_else(|| format!("fragment for unknown track {}", track_id))?;
        let dur_d = def_dur.unwrap_or(t.trex_duration);
        let size_d = def_size.unwrap_or(t.trex_size);
        let flags_d = def_flags.unwrap_or(t.trex_flags);
        if let Some(tfdt) = kids.iter().find(|k| &k.typ == b"tfdt") {
            let dts = if version(tfdt.body)? == 1 { be64(tfdt.body, 4)? } else { be32(tfdt.body, 4)? as u64 };
            if t.samples.is_empty() {
                t.first_dts = Some(dts);
                t.next_dts = dts;
            } else if dts > t.next_dts {
                // Gap between fragments (dropped frames): stretch the previous sample so A/V stay in sync.
                let gap = (dts - t.next_dts).min(u32::MAX as u64) as u32;
                if let Some(last) = t.samples.last_mut() { last.duration = last.duration.saturating_add(gap); }
                t.next_dts = dts;
            } else if dts < t.next_dts {
                // Overlap: the previous fragment's last sample was estimated too long.
                // Shorten it (never below 1 tick) - the fragment's own start time wins.
                if let Some(last) = t.samples.last_mut() {
                    let cut = (t.next_dts - dts).min(last.duration.saturating_sub(1) as u64) as u32;
                    last.duration -= cut;
                    t.next_dts -= cut as u64;
                }
            }
        }
        let mut cursor = base;
        for trun in kids.iter().filter(|k| &k.typ == b"trun") {
            let b = trun.body;
            let ver = version(b)?;
            let fl = be32(b, 0)? & 0x00FF_FFFF;
            let count = be32(b, 4)?;
            let mut p = 8;
            if fl & 0x1 != 0 { let off = be32(b, p)? as i32; cursor = (base as i64 + off as i64) as u64; p += 4; }
            let mut first_flags = None; if fl & 0x4 != 0 { first_flags = Some(be32(b, p)?); p += 4; }
            let chunk_start = cursor;
            for i in 0..count {
                let duration = if fl & 0x100 != 0 { let v = be32(b, p)?; p += 4; v } else { dur_d };
                let size = if fl & 0x200 != 0 { let v = be32(b, p)?; p += 4; v } else { size_d };
                let mut sflags = if fl & 0x400 != 0 { let v = be32(b, p)?; p += 4; v } else { flags_d };
                if i == 0 { if let Some(ff) = first_flags { sflags = ff; } }
                let cto = if fl & 0x800 != 0 { let v = be32(b, p)?; p += 4; if ver == 0 { v.min(i32::MAX as u32) as i32 } else { v as i32 } } else { 0 };
                t.samples.push(Sample { size, duration, flags: sflags, cto });
                t.next_dts += duration as u64;
                cursor += size as u64;
            }
            if count > 0 { t.chunks.push((chunk_start, count)); }
        }
        prev_traf_end = Some(cursor);
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum DurKind { Mvhd, Tkhd, Mdhd }

// Copies a full box (raw, 8-byte header) with its duration field replaced.
// Offsets per ISO 14496-12 (body offsets after the 4-byte version/flags):
// mvhd/mdhd v1 @24 (u64), v0 @16 (u32); tkhd v1 @28 (u64), v0 @20 (u32).
fn patch_duration(raw: &[u8], kind: DurKind, dur: u64) -> Result<Vec<u8>, String> {
    let mut out = raw.to_vec();
    let ver = *out.get(8).ok_or("empty full box")?;
    let body_off = match (kind, ver) {
        (DurKind::Tkhd, 1) => 28, (DurKind::Tkhd, 0) => 20,
        (DurKind::Mvhd | DurKind::Mdhd, 1) => 24, (DurKind::Mvhd | DurKind::Mdhd, 0) => 16,
        _ => return Err(format!("unsupported box version {}", ver)),
    };
    let off = 8 + body_off;
    if ver == 1 {
        out.get_mut(off..off + 8).ok_or("short box")?.copy_from_slice(&dur.to_be_bytes());
    } else {
        let d = u32::try_from(dur).map_err(|_| "duration too large for a version-0 box".to_string())?;
        out.get_mut(off..off + 4).ok_or("short box")?.copy_from_slice(&d.to_be_bytes());
    }
    Ok(out)
}

fn build_stbl(stsd_raw: &[u8], t: &Track) -> Vec<u8> {
    let mut body = stsd_raw.to_vec();

    let mut stts: Vec<(u32, u32)> = vec![];
    for s in &t.samples { match stts.last_mut() { Some((c, d)) if *d == s.duration => *c += 1, _ => stts.push((1, s.duration)) } }
    let mut b = (stts.len() as u32).to_be_bytes().to_vec();
    for (c, d) in &stts { b.extend_from_slice(&c.to_be_bytes()); b.extend_from_slice(&d.to_be_bytes()); }
    body.extend(make_full_box(b"stts", 0, 0, &b));

    if t.samples.iter().any(|s| s.cto != 0) {
        let mut runs: Vec<(u32, i32)> = vec![];
        for s in &t.samples { match runs.last_mut() { Some((c, o)) if *o == s.cto => *c += 1, _ => runs.push((1, s.cto)) } }
        let ver = if t.samples.iter().any(|s| s.cto < 0) { 1 } else { 0 };
        let mut b = (runs.len() as u32).to_be_bytes().to_vec();
        for (c, o) in &runs { b.extend_from_slice(&c.to_be_bytes()); b.extend_from_slice(&o.to_be_bytes()); }
        body.extend(make_full_box(b"ctts", ver, 0, &b));
    }

    // sample_is_non_sync_sample = bit 16 of sample flags. Omit stss when every sample is a keyframe (audio).
    if t.samples.iter().any(|s| s.flags & 0x0001_0000 != 0) {
        let sync: Vec<u32> = t.samples.iter().enumerate().filter(|(_, s)| s.flags & 0x0001_0000 == 0).map(|(i, _)| i as u32 + 1).collect();
        let mut b = (sync.len() as u32).to_be_bytes().to_vec();
        for n in &sync { b.extend_from_slice(&n.to_be_bytes()); }
        body.extend(make_full_box(b"stss", 0, 0, &b));
    }

    let mut stsc: Vec<(u32, u32)> = vec![];
    for (i, (_, n)) in t.chunks.iter().enumerate() { if stsc.last().map(|l| l.1) != Some(*n) { stsc.push((i as u32 + 1, *n)); } }
    let mut b = (stsc.len() as u32).to_be_bytes().to_vec();
    for (first, n) in &stsc { b.extend_from_slice(&first.to_be_bytes()); b.extend_from_slice(&n.to_be_bytes()); b.extend_from_slice(&1u32.to_be_bytes()); }
    body.extend(make_full_box(b"stsc", 0, 0, &b));

    let mut b = 0u32.to_be_bytes().to_vec();
    b.extend_from_slice(&(t.samples.len() as u32).to_be_bytes());
    for s in &t.samples { b.extend_from_slice(&s.size.to_be_bytes()); }
    body.extend(make_full_box(b"stsz", 0, 0, &b));

    let mut b = (t.chunks.len() as u32).to_be_bytes().to_vec();
    for (off, _) in &t.chunks { b.extend_from_slice(&off.to_be_bytes()); }
    body.extend(make_full_box(b"co64", 0, 0, &b));

    make_box(b"stbl", &body)
}

fn make_edts(delay_movie: u64, dur_movie: u64) -> Vec<u8> {
    let mut e = 2u32.to_be_bytes().to_vec();
    e.extend_from_slice(&delay_movie.to_be_bytes()); e.extend_from_slice(&(-1i64).to_be_bytes()); e.extend_from_slice(&[0, 1, 0, 0]);
    e.extend_from_slice(&dur_movie.to_be_bytes()); e.extend_from_slice(&0i64.to_be_bytes()); e.extend_from_slice(&[0, 1, 0, 0]);
    make_box(b"edts", &make_full_box(b"elst", 1, 0, &e))
}

fn rebuild_minf(body: &[u8], t: &Track) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for k in children(body)? {
        if &k.typ == b"stbl" {
            let sk = children(k.body)?;
            out.extend(build_stbl(find(&sk, b"stsd")?.raw, t));
        } else { out.extend_from_slice(k.raw); }
    }
    Ok(make_box(b"minf", &out))
}

fn rebuild_mdia(body: &[u8], t: &Track, media_dur: u64) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for k in children(body)? {
        match &k.typ {
            b"mdhd" => out.extend(patch_duration(k.raw, DurKind::Mdhd, media_dur)?),
            b"minf" => out.extend(rebuild_minf(k.body, t)?),
            _ => out.extend_from_slice(k.raw),
        }
    }
    Ok(make_box(b"mdia", &out))
}

fn rebuild_trak(body: &[u8], t: &Track, media_dur: u64, delay_movie: u64, dur_movie: u64) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for k in children(body)? {
        match &k.typ {
            b"tkhd" => {
                out.extend(patch_duration(k.raw, DurKind::Tkhd, delay_movie + dur_movie)?);
                if delay_movie > 0 { out.extend(make_edts(delay_movie, dur_movie)); }
            }
            b"edts" => {} // replaced above when needed
            b"mdia" => out.extend(rebuild_mdia(k.body, t, media_dur)?),
            _ => out.extend_from_slice(k.raw),
        }
    }
    Ok(make_box(b"trak", &out))
}

fn rebuild_moov(moov_body: &[u8], tracks: &[Track]) -> Result<(Vec<u8>, f64), String> {
    let kids = children(moov_body)?;
    let mvhd = find(&kids, b"mvhd")?;
    let movie_ts = (if version(mvhd.body)? == 1 { be32(mvhd.body, 20)? } else { be32(mvhd.body, 12)? }) as u64;
    if movie_ts == 0 { return Err("movie timescale is 0".into()); }
    let mut movie_dur = 0u64;
    let mut per: Vec<(u32, u64, u64, u64)> = vec![]; // (id, media_dur, delay_movie, dur_movie)
    for t in tracks {
        let media_dur: u64 = t.samples.iter().map(|s| s.duration as u64).sum();
        let ts = t.media_timescale as u64;
        let delay_movie = t.first_dts.unwrap_or(0) * movie_ts / ts;
        let dur_movie = media_dur * movie_ts / ts;
        movie_dur = movie_dur.max(delay_movie + dur_movie);
        per.push((t.id, media_dur, delay_movie, dur_movie));
    }
    let mut out = vec![];
    for k in &kids {
        match &k.typ {
            b"mvhd" => out.extend(patch_duration(k.raw, DurKind::Mvhd, movie_dur)?),
            b"mvex" => {}
            b"trak" => {
                let (id, _) = track_id_and_timescale(k.body)?;
                let t = tracks.iter().find(|t| t.id == id).ok_or("trak/track mismatch")?;
                let &(_, media_dur, delay, dur_movie) = per.iter().find(|p| p.0 == id).ok_or("trak/track mismatch")?;
                out.extend(rebuild_trak(k.body, t, media_dur, delay, dur_movie)?);
            }
            _ => out.extend_from_slice(k.raw),
        }
    }
    Ok((make_box(b"moov", &out), movie_dur as f64 / movie_ts as f64))
}

fn write_type(f: &mut File, box_start: u64, typ: &[u8; 4]) -> Result<(), String> {
    f.seek(SeekFrom::Start(box_start + 4)).map_err(|e| e.to_string())?;
    f.write_all(typ).map_err(|e| e.to_string())
}

pub fn defragment_in_place(path: &Path) -> Result<DefragReport, String> {
    let mut f = OpenOptions::new().read(true).write(true).open(path).map_err(|e| format!("could not open recording: {}", e))?;
    let file_len = f.metadata().map_err(|e| e.to_string())?.len();

    // 1. Parse everything first. No writes happen unless this whole block succeeds.
    let mut top = vec![];
    let mut pos = 0u64;
    while let Some(h) = read_hdr(&mut f, pos, file_len)? { pos = h.start + h.size; top.push(h); }
    let moovs: Vec<BoxHdr> = top.iter().copied().filter(|h| &h.typ == b"moov").collect();
    if moovs.len() != 1 { return Err(format!("expected exactly one moov box, found {}", moovs.len())); }
    let moov_h = moovs[0];
    let moof_hdrs: Vec<BoxHdr> = top.iter().copied().filter(|h| &h.typ == b"moof").collect();
    if moof_hdrs.is_empty() { return Err("no moof boxes - already a regular MP4, nothing to do".into()); }

    let moov_body = read_body(&mut f, &moov_h)?;
    let moov_kids = children(&moov_body)?;
    let mut tracks = vec![];
    for k in moov_kids.iter().filter(|k| &k.typ == b"trak") {
        let (id, ts) = track_id_and_timescale(k.body)?;
        tracks.push(Track { id, media_timescale: ts, trex_duration: 0, trex_size: 0, trex_flags: 0, samples: vec![], chunks: vec![], first_dts: None, next_dts: 0 });
    }
    if let Some(mvex) = moov_kids.iter().find(|k| &k.typ == b"mvex") {
        for trex in children(mvex.body)?.iter().filter(|k| &k.typ == b"trex") {
            let id = be32(trex.body, 4)?;
            if let Some(t) = tracks.iter_mut().find(|t| t.id == id) {
                t.trex_duration = be32(trex.body, 12)?;
                t.trex_size = be32(trex.body, 16)?;
                t.trex_flags = be32(trex.body, 20)?;
            }
        }
    }
    for h in &moof_hdrs { let body = read_body(&mut f, h)?; parse_moof(h.start, &body, &mut tracks)?; }
    for t in &tracks { if t.samples.is_empty() { return Err(format!("track {} has no samples", t.id)); } }
    for t in &tracks { for (off, _) in &t.chunks { if *off >= file_len { return Err("sample data points past end of file".into()); } } }
    let (new_moov, duration_secs) = rebuild_moov(&moov_body, &tracks)?;

    // 2. Write. Append the new index labelled 'free' (invisible to players),
    //    flush, then flip labels: fragments -> free, old moov -> free, new -> moov.
    let mut staged = new_moov.clone();
    staged[4..8].copy_from_slice(b"free");
    f.seek(SeekFrom::Start(file_len)).map_err(|e| e.to_string())?;
    f.write_all(&staged).map_err(|e| e.to_string())?;
    f.sync_data().map_err(|e| e.to_string())?;
    for h in top.iter().filter(|h| &h.typ == b"moof" || &h.typ == b"mfra") { write_type(&mut f, h.start, b"free")?; }
    write_type(&mut f, moov_h.start, b"free")?;
    write_type(&mut f, file_len, b"moov")?;
    f.sync_all().map_err(|e| e.to_string())?;

    Ok(DefragReport { fragments: moof_hdrs.len(), samples: tracks.iter().map(|t| t.samples.len()).sum(), duration_secs })
}

#[tauri::command]
pub async fn mp4_defragment(path: String) -> Result<DefragReport, String> {
    if !path.to_ascii_lowercase().ends_with(".mp4") { return Err("not an .mp4 file".into()); }
    tauri::async_runtime::spawn_blocking(move || defragment_in_place(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::path::PathBuf;
    use std::process::Command;

    const FIXTURES: [&str; 3] = ["rec-45s.mp4", "rec-frag-moof.mp4", "rec-frag-explicit.mp4"];

    fn fixture_copy(name: &str, tag: &str) -> PathBuf {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
        let dst = std::env::temp_dir().join(format!("bko-mp4fix-{}-{}-{}", std::process::id(), tag, name));
        std::fs::copy(&src, &dst).unwrap();
        dst
    }

    fn top_types(path: &Path) -> Vec<String> {
        let mut f = File::open(path).unwrap();
        let len = f.metadata().unwrap().len();
        let mut out = vec![];
        let mut pos = 0;
        while let Some(h) = read_hdr(&mut f, pos, len).unwrap() {
            out.push(String::from_utf8_lossy(&h.typ).to_string());
            pos = h.start + h.size;
        }
        out
    }

    #[test]
    fn converts_to_single_trailing_moov_without_fragments() {
        for name in FIXTURES {
            let p = fixture_copy(name, "conv");
            let before = std::fs::metadata(&p).unwrap().len();
            let rep = defragment_in_place(&p).unwrap();
            let types = top_types(&p);
            assert!(!types.iter().any(|t| t == "moof" || t == "mfra"), "{}: {:?}", name, types);
            assert_eq!(types.iter().filter(|t| *t == "moov").count(), 1, "{}", name);
            assert_eq!(types.last().unwrap(), "moov", "{}", name);
            assert!(std::fs::metadata(&p).unwrap().len() > before);
            assert!(rep.samples > 0 && rep.fragments > 0 && rep.duration_secs > 1.0, "{}: {:?}", name, rep);
        }
    }

    #[test]
    fn second_run_refuses_and_leaves_file_untouched() {
        let p = fixture_copy("rec-frag-moof.mp4", "twice");
        defragment_in_place(&p).unwrap();
        let before = std::fs::read(&p).unwrap();
        let err = defragment_in_place(&p).unwrap_err();
        assert!(err.contains("no moof"), "{}", err);
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }

    #[test]
    fn truncated_file_is_rejected_without_modification() {
        let p = fixture_copy("rec-frag-moof.mp4", "trunc");
        let data = std::fs::read(&p).unwrap();
        std::fs::write(&p, &data[..data.len() - 1000]).unwrap();
        let before = std::fs::read(&p).unwrap();
        assert!(defragment_in_place(&p).is_err());
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }

    fn probe(p: &Path, args: &[&str]) -> Option<String> {
        let o = Command::new("ffprobe").args(args).arg(p).output().ok()?;
        if !o.status.success() { return None; }
        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
    }

    // Review finding: fragment start times (tfdt) are authoritative. The
    // ffmpeg-made fixture has a 4-tick OVERLAP at its 2nd video fragment;
    // ignoring overlaps (only fixing gaps) shifts every later timestamp and,
    // over a 3-hour meeting, drifts audio vs video. Every packet's decode
    // timestamp must survive conversion exactly.
    #[test]
    fn packet_timestamps_identical_after_conversion() {
        for name in FIXTURES {
            let orig = fixture_copy(name, "ts-orig");
            let fixed = fixture_copy(name, "ts-fixed");
            defragment_in_place(&fixed).unwrap();
            for stream in ["v:0", "a:0"] {
                let args = ["-v", "error", "-select_streams", stream, "-show_entries", "packet=dts", "-of", "csv=p=0"];
                let Some(before) = probe(&orig, &args) else { eprintln!("ffprobe not on PATH - skipping"); return; };
                let after = probe(&fixed, &args).unwrap();
                // csv rows can carry trailing side-data columns (e.g. "2022310,") - compare the dts field only
                let dts = |s: &str| s.split(',').next().unwrap_or("").trim().to_string();
                let (b, a): (Vec<String>, Vec<String>) = (before.lines().map(dts).collect(), after.lines().map(dts).collect());
                assert_eq!(b.len(), a.len(), "{} {} packet count", name, stream);
                if let Some(i) = (0..b.len()).find(|&i| b[i] != a[i]) {
                    panic!("{} {} first dts mismatch at packet {}: {} vs {}", name, stream, i, b[i], a[i]);
                }
            }
        }
    }

    fn video_trak_body(moov_body: &[u8]) -> Vec<u8> {
        for k in children(moov_body).unwrap().iter().filter(|k| &k.typ == b"trak") {
            let tk = children(k.body).unwrap();
            let mk = children(find(&tk, b"mdia").unwrap().body).unwrap();
            if &find(&mk, b"hdlr").unwrap().body[8..12] == b"vide" { return k.body.to_vec(); }
        }
        panic!("no video track")
    }

    fn top_box_body(path: &Path, typ: &[u8; 4], last: bool) -> Vec<u8> {
        let mut f = File::open(path).unwrap();
        let len = f.metadata().unwrap().len();
        let (mut pos, mut found) = (0, None);
        while let Some(h) = read_hdr(&mut f, pos, len).unwrap() {
            if &h.typ == typ { found = Some(h); if !last { break; } }
            pos = h.start + h.size;
        }
        read_body(&mut f, &found.unwrap()).unwrap()
    }

    // For each video traf, in file order: (file offset of its tfdt value, tfdt version, tfdt value, sample count)
    fn video_frags(path: &Path, vid: u32) -> Vec<(u64, u8, u64, u32)> {
        let mut f = File::open(path).unwrap();
        let len = f.metadata().unwrap().len();
        let (mut pos, mut out) = (0, vec![]);
        while let Some(h) = read_hdr(&mut f, pos, len).unwrap() {
            if &h.typ == b"moof" {
                let body = read_body(&mut f, &h).unwrap();
                for traf in children(&body).unwrap().iter().filter(|c| &c.typ == b"traf") {
                    let kids = children(traf.body).unwrap();
                    if be32(find(&kids, b"tfhd").unwrap().body, 4).unwrap() != vid { continue; }
                    let tfdt = find(&kids, b"tfdt").unwrap();
                    let ver = tfdt.body[0];
                    let value = if ver == 1 { be64(tfdt.body, 4).unwrap() } else { be32(tfdt.body, 4).unwrap() as u64 };
                    let off = h.start + h.header_len + (tfdt.raw.as_ptr() as u64 - body.as_ptr() as u64) + 8 + 4;
                    let count: u32 = kids.iter().filter(|k| &k.typ == b"trun").map(|k| be32(k.body, 4).unwrap()).sum();
                    out.push((off, ver, value, count));
                }
            }
            pos = h.start + h.size;
        }
        out
    }

    // Review finding: a fragment's own start time (tfdt) is authoritative. If
    // the previous fragment's last sample was estimated too LONG (an
    // overlap), it must be shortened - otherwise every later timestamp
    // shifts and a 3-hour meeting drifts audio vs video.
    #[test]
    fn fragment_start_times_win_over_estimated_durations() {
        let p = fixture_copy("rec-frag-moof.mp4", "overlap");
        let vid = track_id_and_timescale(&video_trak_body(&top_box_body(&p, b"moov", false))).unwrap().0;
        let frags = video_frags(&p, vid);
        let (off, ver, value, _) = frags[2];
        let target = value - 3; // plant a 3-tick overlap before video fragment #2
        {
            let mut f = OpenOptions::new().write(true).open(&p).unwrap();
            f.seek(SeekFrom::Start(off)).unwrap();
            if ver == 1 { f.write_all(&target.to_be_bytes()).unwrap(); } else { f.write_all(&(target as u32).to_be_bytes()).unwrap(); }
        }
        defragment_in_place(&p).unwrap();
        let trak = video_trak_body(&top_box_body(&p, b"moov", true));
        let tk = children(&trak).unwrap();
        let mk = children(find(&tk, b"mdia").unwrap().body).unwrap();
        let nk = children(find(&mk, b"minf").unwrap().body).unwrap();
        let sk = children(find(&nk, b"stbl").unwrap().body).unwrap();
        let stts = find(&sk, b"stts").unwrap().body;
        let mut durations = vec![];
        for i in 0..be32(stts, 4).unwrap() as usize {
            let (count, delta) = (be32(stts, 8 + i * 8).unwrap(), be32(stts, 12 + i * 8).unwrap());
            durations.extend(std::iter::repeat(delta as u64).take(count as usize));
        }
        let before: usize = frags[..2].iter().map(|f| f.3 as usize).sum();
        let start_of_frag2 = frags[0].2 + durations[..before].iter().sum::<u64>();
        assert_eq!(start_of_frag2, target, "converted timeline must follow the fragment's own start time");
    }

    #[test]
    fn ffmpeg_sees_identical_media_after_conversion() {
        for name in FIXTURES {
            let orig = fixture_copy(name, "orig");
            let fixed = fixture_copy(name, "fixed");
            defragment_in_place(&fixed).unwrap();
            let frames = ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"];
            let Some(f_before) = probe(&orig, &frames) else { eprintln!("ffprobe not on PATH - skipping"); return; };
            assert_eq!(f_before, probe(&fixed, &frames).unwrap(), "{} video frames", name);
            let pkts = ["-v", "error", "-select_streams", "a:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"];
            assert_eq!(probe(&orig, &pkts).unwrap(), probe(&fixed, &pkts).unwrap(), "{} audio packets", name);
            let dur = ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"];
            let d0: f64 = probe(&orig, &dur).unwrap().parse().unwrap();
            let d1: f64 = probe(&fixed, &dur).unwrap().parse().unwrap();
            assert!((d0 - d1).abs() < 0.15, "{} duration {} vs {}", name, d0, d1);
            let dec = Command::new("ffmpeg").args(["-v", "error", "-i"]).arg(&fixed).args(["-f", "null", "-"]).output().unwrap();
            assert!(dec.stderr.is_empty(), "{} decode errors: {}", name, String::from_utf8_lossy(&dec.stderr));
        }
    }
}
