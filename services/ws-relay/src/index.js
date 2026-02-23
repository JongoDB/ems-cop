const express = require('express');
const app = express();
const port = process.env.SERVICE_PORT || 3000;
const name = process.env.SERVICE_NAME || 'ws-relay';
app.use(express.json());
app.get('/health', (req, res) => res.json({ status: 'ok', service: name }));
app.listen(port, () => console.log('[' + name + '] listening on :' + port));
