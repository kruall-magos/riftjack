// Local loopback benchmark; never connects to Matrix or loads account credentials.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { writeFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { Attachment } from '@matrix-org/matrix-sdk-crypto-nodejs';
import { MatrixClient } from '@vector-im/matrix-bot-sdk';
import { MatrixMedia, readOutgoing } from '../src/media.js';
const [mode, path, reportPath] = process.argv.slice(2);
if (!['buffered','streamed'].includes(mode) || !path || !reportPath) throw new Error('Expected mode, input path and report path');
const file = { path, root: dirname(path) }, size = statSync(path).size;
let received = 0, serverHash = '', receiveMs = 0;
const server = createServer((req, res) => { void (async () => {
  const start = performance.now(), hash = createHash('sha256');
  for await (const chunk of req) { received += chunk.length; hash.update(chunk); }
  serverHash = hash.digest('base64').replace(/=+$/, ''); receiveMs = performance.now() - start;
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({content_uri:'mxc://test/id'}));
})().catch(() => { res.destroy(); }); });
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const homeserver = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
const baseline = process.memoryUsage().rss, start = performance.now();
let hash = '', measurements: unknown[] = [];
try {
  if (mode === 'streamed') {
    const media = new MatrixMedia({ mxcToHttp: async () => '', sendMessage: async () => '' }, {
      workspace: file.root, homeserver, accessToken: 'loopback-test', maxBytes: size, scope: 'benchmark',
      reportUpload: record => measurements.push(record),
    });
    const result = await media.prepareAttachment(file, new AbortController().signal, async () => {});
    hash = (result.file as { hashes: {sha256:string} }).hashes.sha256;
  } else {
    const data = await readOutgoing(file, size);
    const encrypted = Attachment.encrypt(data);
    hash = JSON.parse(encrypted.mediaEncryptionInfo!).hashes.sha256;
    await new MatrixClient(homeserver, 'loopback-test').uploadContent(Buffer.from(encrypted.encryptedData), 'application/octet-stream');
  }
  if (received !== size || serverHash !== hash) throw new Error('Ciphertext size or hash mismatch');
  const result = {mode, size, elapsedMs:Math.round(performance.now()-start), receiveMs:Math.round(receiveMs),
    baselineRssBytes:baseline, peakRssBytes:process.resourceUsage().maxRSS*1024,
    finalRssBytes:process.memoryUsage().rss, ciphertextVerified:true, measurements,
    scope:'Isolated Node process with loopback HTTP receiver; no Matrix connection; kernel high-water RSS includes receiver.'};
  writeFileSync(reportPath, JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
} finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
