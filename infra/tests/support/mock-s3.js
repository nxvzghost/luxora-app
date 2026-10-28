// Armazenamento S3 FALSO para o teste local de infra/scripts/external-backup.sh.
// Escuta só em 127.0.0.1; guarda os objetos em disco; não valida a assinatura (só o
// formato do cabeçalho Authorization e o x-amz-content-sha256 contra o corpo).
// Uso: node mock-s3.js <diretório-dos-objetos> <access-key-id> <região> <arquivo-da-porta>
//   <diretório>/../fail-put   existe -> todo PUT responde 500
//   <diretório>/../requests.log recebe uma linha por requisição (sem segredo)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [dir, accessKey, region, portFile] = process.argv.slice(2);
const flag = (name) => fs.existsSync(path.join(dir, '..', name));
const log = (line) => fs.appendFileSync(path.join(dir, '..', 'requests.log'), line + '\n');
const authRe = new RegExp(
  '^AWS4-HMAC-SHA256 Credential=' + accessKey + '/\\d{8}/' + region + '/s3/aws4_request, SignedHeaders=([^,]+), Signature=[0-9a-f]{64}$',
);

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const match = authRe.exec(req.headers['authorization'] || '');
      const file = path.join(dir, decodeURIComponent(req.url.split('?')[0]));
      if (!file.startsWith(dir)) { res.writeHead(400).end(); return; }
      log(`${req.method} ${req.url} auth=${match ? 'ok' : 'INVALIDA'} signed=${match ? match[1] : '-'}`);
      if (!match) { res.writeHead(403).end(); return; }
      if (req.method === 'PUT') {
        if (flag('fail-put')) { res.writeHead(500).end(); return; }
        const declared = req.headers['x-amz-content-sha256'];
        if (declared !== crypto.createHash('sha256').update(body).digest('hex')) { res.writeHead(400).end('sha256'); return; }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
        res.writeHead(200).end();
      } else if (req.method === 'HEAD' || req.method === 'GET') {
        if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'Content-Length': data.length });
        res.end(req.method === 'GET' ? data : undefined);
      } else {
        res.writeHead(405).end();
      }
    });
  })
  .listen(0, '127.0.0.1', function () {
    fs.writeFileSync(portFile, String(this.address().port));
  });
