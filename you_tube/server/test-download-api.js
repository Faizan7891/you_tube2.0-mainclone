import fetch from 'node-fetch';
import fs from 'fs';

async function run() {
  const videoId = fs.readFileSync('mock-video-id.txt', 'utf8').trim();
  
  console.log(\`Testing download check for video \${videoId}\`);
  try {
    const res = await fetch(\`http://localhost:5000/download/check/\${videoId}?deviceId=123\`, {
      headers: {
        'x-device-id': '123'
      }
    });
    const text = await res.text();
    console.log("Check response:", res.status, text);
  } catch (error) {
    console.error(error);
  }
}
run();
