const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8080;

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
    let p = path.join(root, decodeURIComponent(req.url).split('?')[0]);
    if (p.endsWith(path.sep)) p += 'index.html';
    fs.stat(p, (err, stat) => {
        if (err || !stat.isFile()) {
            res.writeHead(404); res.end('Not found'); return;
        }
        const ext = path.extname(p).toLowerCase();
        res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
        fs.createReadStream(p).pipe(res);
    });
}).listen(port, '127.0.0.1', () => {
    console.log('Server at http://127.0.0.1:' + port);
});
