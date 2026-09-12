import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const videoSchema = new mongoose.Schema({}, { strict: false });
const Video = mongoose.model('Video', videoSchema, 'videofiles');

async function run() {
  await mongoose.connect(process.env.DB_URL);
  
  const videoId = "6aa51eeeed47fca94a69e0b0"; // From user screenshot
  const video = await Video.findById(videoId);
  
  if (!video) {
    console.log("Video not found in DB");
    process.exit(1);
  }
  
  console.log("Filepath:", video.get('filepath'));
  console.log("Filename:", video.get('filename'));
  console.log("Filesize:", video.get('filesize'));
  
  const resolved = path.resolve(video.get('filepath'));
  console.log("Resolved path:", resolved);
  console.log("fs.existsSync:", fs.existsSync(resolved));
  console.log("Original fs.existsSync:", fs.existsSync(video.get('filepath')));
  
  process.exit(0);
}
run();
