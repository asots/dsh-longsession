/**
 * Serves the browser harness for dsh-longsession without a build step.
 *
 *   node plugins/dsh-longsession/test/serve.mjs [port]
 *
 * Open http://127.0.0.1:<port>/harness.html and read window.__TEST_RESULTS__.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const port = Number(process.argv[2] ?? 17772)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let path
    if (url.pathname === '/' || url.pathname === '/harness.html') path = join(here, 'harness.html')
    else if (url.pathname === '/client.js') path = join(here, '..', 'lib', 'client.js')
    else {
      response.writeHead(404)
      response.end('not found')
      return
    }
    const body = await readFile(path)
    const extension = path.slice(path.lastIndexOf('.'))
    response.writeHead(200, {
      'content-type': types[extension] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch (error) {
    response.writeHead(500)
    response.end(String(error))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.error(`dsh-longsession harness: http://127.0.0.1:${port}/harness.html`)
})