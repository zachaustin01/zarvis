// A short fingerprint of the files the browser loads (public/), so an open page can tell that the app on disk
// has changed and offer to reload. Read-only; the hash only moves when a file's name, size or mtime does.
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/** 8 hex chars over every regular file in `dir` (name, size, mtime), or '' when the directory cannot be read. */
export async function appVersion(dir) {
  try {
    const names = (await fsp.readdir(dir)).sort()
    const h = crypto.createHash('sha1')
    for (const n of names) {
      const st = await fsp.stat(path.join(dir, n))
      if (st.isFile()) h.update(`${n}:${st.size}:${Math.floor(st.mtimeMs)};`)
    }
    return h.digest('hex').slice(0, 8)
  } catch {
    return ''
  }
}
