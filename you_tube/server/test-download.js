import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import dns from 'dns';

dns.setServers(['1.1.1.1', '8.8.8.8']);
dotenv.config();

const userSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', userSchema, 'auths');

const videoSchema = new mongoose.Schema({}, { strict: false });
const Video = mongoose.model('Video', videoSchema, 'videofiles');

async function run() {
  await mongoose.connect(process.env.DB_URL);
  const user = await User.findOne();
  const video = await Video.findOne();
  
  console.log("User email:", user.get('email'));
  console.log("Video ID:", video._id);
  
  fs.writeFileSync('mock-email.txt', user.get('email'));
  fs.writeFileSync('mock-video-id.txt', video._id.toString());
  
  process.exit(0);
}
run();
