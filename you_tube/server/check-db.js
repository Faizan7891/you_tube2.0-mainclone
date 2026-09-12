import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const videoSchema = new mongoose.Schema({}, { strict: false });
const Video = mongoose.model('Video', videoSchema, 'videofiles');

async function run() {
  try {
    await mongoose.connect(process.env.DB_URL);
    const videos = await Video.find({}).limit(5);
    const data = videos.map(v => ({
      _id: v._id,
      filepath: v.get('filepath'),
      filename: v.get('filename')
    }));
    fs.writeFileSync('db-videos.json', JSON.stringify(data, null, 2));
    console.log("Wrote db-videos.json");
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
