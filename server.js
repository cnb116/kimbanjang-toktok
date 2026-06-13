const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'server_datasets');
const MODEL_STATE_FILE = path.join(DATA_DIR, 'model_state.json');
const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');

// Ensure dataset directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initial Model State
let modelState = {
    version: 'v1.0.0',
    accuracy: 72.5,
    status: 'idle', // idle, training
    progress: 0,
    loss: 0.85
};

// Load existing state if available
if (fs.existsSync(MODEL_STATE_FILE)) {
    try {
        modelState = JSON.parse(fs.readFileSync(MODEL_STATE_FILE, 'utf8'));
    } catch (e) {
        console.error('Error reading model state, using default:', e.message);
    }
} else {
    fs.writeFileSync(MODEL_STATE_FILE, JSON.stringify(modelState, null, 2));
}

// Load metadata
let metadataList = [];
if (fs.existsSync(METADATA_FILE)) {
    try {
        metadataList = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
    } catch (e) {
        console.error('Error reading metadata file, using empty list:', e.message);
    }
}

// Helper to save state
function saveModelState() {
    fs.writeFileSync(MODEL_STATE_FILE, JSON.stringify(modelState, null, 2));
}

function saveMetadata() {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadataList, null, 2));
}

// MIME Types for Static File Serving
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4'
};

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS Headers for API
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-metadata');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // API: GET /api/status
    if (pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            datasetSize: metadataList.length,
            modelState: modelState
        }));
        return;
    }

    // API: POST /api/upload
    if (pathname === '/api/upload' && req.method === 'POST') {
        let metaStr = parsedUrl.query.metadata;
        if (!metaStr) {
            metaStr = req.headers['x-metadata'];
        }

        if (!metaStr) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Metadata is missing' }));
            return;
        }

        try {
            const itemMetadata = JSON.parse(decodeURIComponent(metaStr));
            const id = Date.now();
            const filename = `video_${id}.webm`;
            const videoPath = path.join(DATA_DIR, filename);

            const fileStream = fs.createWriteStream(videoPath);
            req.pipe(fileStream);

            req.on('end', () => {
                itemMetadata.id = id;
                itemMetadata.videoPath = videoPath;
                itemMetadata.filename = filename;
                
                metadataList.push(itemMetadata);
                saveMetadata();

                console.log(`[Server] Dataset item uploaded: ${filename}, metadata saved.`);
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, id: id }));
            });

            req.on('error', (err) => {
                console.error('[Server] Upload error:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
            });
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid metadata JSON' }));
        }
        return;
    }

    // API: POST /api/train
    if (pathname === '/api/train' && req.method === 'POST') {
        if (modelState.status === 'training') {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Already training' }));
            return;
        }

        if (metadataList.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'No data to train on. Please upload datasets first.' }));
            return;
        }

        // Start mock training
        modelState.status = 'training';
        modelState.progress = 0;
        modelState.loss = 0.85;
        saveModelState();

        console.log(`[Server] Starting AI model training on ${metadataList.length} items...`);

        const trainingInterval = setInterval(() => {
            if (modelState.progress < 100) {
                modelState.progress += 5;
                modelState.loss = Math.max(0.04, (modelState.loss - 0.04 * (Math.random() + 0.5))).toFixed(4);
                modelState.loss = parseFloat(modelState.loss);
                
                // Gradually improve accuracy based on dataset size
                // More files = higher potential accuracy
                const maxPotentialAcc = Math.min(99.9, 75 + metadataList.length * 3);
                const step = (maxPotentialAcc - modelState.accuracy) * 0.06;
                modelState.accuracy = parseFloat(Math.min(maxPotentialAcc, modelState.accuracy + step).toFixed(2));
                
                saveModelState();
            } else {
                clearInterval(trainingInterval);
                modelState.status = 'idle';
                modelState.progress = 0;
                
                // Bump Version
                const parts = modelState.version.replace('v', '').split('.');
                parts[2] = parseInt(parts[2]) + 1; // Increment patch version
                modelState.version = `v${parts.join('.')}`;
                
                saveModelState();
                console.log(`[Server] AI model training completed! New version: ${modelState.version}, Accuracy: ${modelState.accuracy}%`);
            }
        }, 300);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // Serve Static Files
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    
    // Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.exists(filePath, (exists) => {
        if (!exists) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`👷 김반장 톡톡 로컬 AI 서버가 구동되었습니다.`);
    console.log(`🔗 접속 주소: http://localhost:${PORT}`);
    console.log(`==================================================`);
});
