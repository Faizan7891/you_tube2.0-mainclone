import express from 'express';
import path from 'path';

const app = express();

app.get('/test', (req, res) => {
  const filePath = path.resolve('uploads\\1788959929117-vid2.mp4'); // Replace with actual existing file
  console.log("Downloading:", filePath);
  res.download(filePath, (err) => {
    if (err) {
      console.log("Error:", err.message);
      res.status(500).send(`Failed: ${err.message}`);
    } else {
      console.log("Success");
    }
  });
});

app.listen(5001, () => {
  console.log("Test server on 5001");
});
