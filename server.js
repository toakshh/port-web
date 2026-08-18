const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure required directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const jobsDir = path.join(__dirname, 'jobs');
const distBuildsDir = path.join(__dirname, 'dist-builds');

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(jobsDir, { recursive: true });
fs.mkdirSync(distBuildsDir, { recursive: true });

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500 MB limit
});

// Memory store for job metadata
const jobsMap = new Map();

// Helper: Copy directory recursively
function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;
  const stats = fs.statSync(src);
  if (stats.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      copyRecursiveSync(path.join(src, item), path.join(dest, item));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// Helper: Flatten extracted ZIP if single root folder exists without index.html at root
function normalizeZipExtraction(dir) {
  if (!fs.existsSync(dir)) return;
  const items = fs.readdirSync(dir);
  if (!fs.existsSync(path.join(dir, 'index.html')) && items.length === 1) {
    const singleFolder = path.join(dir, items[0]);
    if (fs.existsSync(singleFolder) && fs.statSync(singleFolder).isDirectory()) {
      const subItems = fs.readdirSync(singleFolder);
      for (const item of subItems) {
        fs.renameSync(path.join(singleFolder, item), path.join(dir, item));
      }
      fs.rmdirSync(singleFolder);
    }
  }
}

// Helper: Ensure environment variables for Tauri/Android builds
function setupEnv() {
  const JDK_DIR = '/home/akshh16/jdk';
  const ANDROID_SDK_DIR = '/home/akshh16/android-sdk';

  if (!process.env.JAVA_HOME && fs.existsSync(JDK_DIR)) {
    process.env.JAVA_HOME = JDK_DIR;
  }
  if (!process.env.ANDROID_HOME && fs.existsSync(ANDROID_SDK_DIR)) {
    process.env.ANDROID_HOME = ANDROID_SDK_DIR;
  }

  const extraPaths = [];
  if (process.env.JAVA_HOME) {
    extraPaths.push(path.join(process.env.JAVA_HOME, 'bin'));
  }
  if (process.env.ANDROID_HOME) {
    extraPaths.push(path.join(process.env.ANDROID_HOME, 'build-tools', '35.0.0'));
    extraPaths.push(path.join(process.env.ANDROID_HOME, 'build-tools', '34.0.0'));
    extraPaths.push(path.join(process.env.ANDROID_HOME, 'platform-tools'));
  }
  if (extraPaths.length > 0) {
    process.env.PATH = [...extraPaths, process.env.PATH].join(path.delimiter);
  }
}
setupEnv();

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  const javaHome = process.env.JAVA_HOME || '/home/akshh16/jdk';
  const androidHome = process.env.ANDROID_HOME || '/home/akshh16/android-sdk';
  const hasJava = fs.existsSync(javaHome);
  const hasAndroid = fs.existsSync(androidHome);

  res.json({
    status: 'ok',
    service: 'Tripo Cloud Web-to-App Converter',
    uptime: Math.floor(process.uptime()),
    capabilities: {
      android: hasJava && hasAndroid,
      windows: true,
      mac: process.platform === 'darwin',
      ios: process.platform === 'darwin'
    },
    environment: {
      platform: process.platform,
      nodeVersion: process.version,
      JAVA_HOME: javaHome,
      ANDROID_HOME: androidHome
    },
    timestamp: new Date().toISOString()
  });
});

// Conversion Endpoint
const convertFields = upload.fields([
  { name: 'webBuild', maxCount: 1 },
  { name: 'appLogo', maxCount: 1 }
]);

app.post('/api/convert', convertFields, async (req, res) => {
  const webBuildFile = req.files && req.files['webBuild'] ? req.files['webBuild'][0] : null;
  const appLogoFile = req.files && req.files['appLogo'] ? req.files['appLogo'][0] : null;

  if (!webBuildFile) {
    return res.status(400).json({ error: 'Missing webBuild ZIP file' });
  }

  const appName = (req.body.appName || '').trim();
  const appIdentifier = (req.body.appIdentifier || '').trim();
  const targetsRaw = (req.body.targets || 'android,exe').trim();

  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const jobDir = path.join(jobsDir, jobId);
  const jobDistDir = path.join(jobDir, 'dist');
  const jobOutputsDir = path.join(jobDir, 'outputs');

  fs.mkdirSync(jobDistDir, { recursive: true });
  fs.mkdirSync(jobOutputsDir, { recursive: true });

  let logoPathInJob = null;

  try {
    console.log(`[JOB ${jobId}] Starting conversion for targets: ${targetsRaw}`);

    // 1. Unzip webBuild into jobDistDir
    const zip = new AdmZip(webBuildFile.path);
    zip.extractAllTo(jobDistDir, true);
    normalizeZipExtraction(jobDistDir);

    // Verify index.html exists
    if (!fs.existsSync(path.join(jobDistDir, 'index.html'))) {
      throw new Error('Extracted web build does not contain an index.html file at root level');
    }

    // 2. Clear main dist/ and copy job dist contents
    const mainDistDir = path.join(__dirname, 'dist');
    fs.rmSync(mainDistDir, { recursive: true, force: true });
    fs.mkdirSync(mainDistDir, { recursive: true });
    copyRecursiveSync(jobDistDir, mainDistDir);

    // 3. Clear dist-builds directory
    fs.rmSync(distBuildsDir, { recursive: true, force: true });
    fs.mkdirSync(distBuildsDir, { recursive: true });

    // 4. Save logo if provided
    if (appLogoFile) {
      const ext = path.extname(appLogoFile.originalname) || '.png';
      logoPathInJob = path.join(jobDir, `logo${ext}`);
      fs.copyFileSync(appLogoFile.path, logoPathInJob);
    }

    // 5. Build CLI options for build.js
    const buildCmdArgs = ['build.js'];
    const targetsList = targetsRaw.toLowerCase().split(',').map(t => t.trim());

    if (targetsList.includes('all')) {
      buildCmdArgs.push('--all');
    } else {
      if (targetsList.includes('android')) buildCmdArgs.push('--android');
      if (targetsList.includes('exe') || targetsList.includes('windows')) buildCmdArgs.push('--exe');
      if (targetsList.includes('mac') || targetsList.includes('dmg')) buildCmdArgs.push('--mac');
      if (targetsList.includes('ios')) buildCmdArgs.push('--ios');
    }

    // Fallback target if none matched
    if (!buildCmdArgs.some(a => ['--android', '--exe', '--mac', '--ios', '--all'].includes(a))) {
      buildCmdArgs.push('--android', '--exe');
    }

    if (appName) {
      buildCmdArgs.push('--name', appName);
    }

    if (appIdentifier) {
      buildCmdArgs.push('--identifier', appIdentifier);
    }

    if (logoPathInJob) {
      buildCmdArgs.push('--logo', logoPathInJob);
    }

    // Backup tauri.conf.json and package.json to restore afterwards
    const tauriConfPath = path.join(__dirname, 'src-tauri', 'tauri.conf.json');
    const pkgJsonPath = path.join(__dirname, 'package.json');
    const originalTauriConf = fs.existsSync(tauriConfPath) ? fs.readFileSync(tauriConfPath, 'utf8') : null;
    const originalPkgJson = fs.existsSync(pkgJsonPath) ? fs.readFileSync(pkgJsonPath, 'utf8') : null;

    try {
      const execCmd = `node ${buildCmdArgs.map(a => `"${a}"`).join(' ')}`;
      console.log(`[JOB ${jobId}] Executing: ${execCmd}`);
      execSync(execCmd, { cwd: __dirname, stdio: 'inherit', env: process.env });
    } finally {
      // Restore tauri.conf.json and package.json
      if (originalTauriConf) fs.writeFileSync(tauriConfPath, originalTauriConf, 'utf8');
      if (originalPkgJson) fs.writeFileSync(pkgJsonPath, originalPkgJson, 'utf8');

      // Cleanup uploaded temp files
      if (fs.existsSync(webBuildFile.path)) fs.unlinkSync(webBuildFile.path);
      if (appLogoFile && fs.existsSync(appLogoFile.path)) fs.unlinkSync(appLogoFile.path);
    }

    // 6. Gather build outputs
    const artifacts = {};
    const artifactFiles = {};

    // Android APK
    const signedApk = path.join(distBuildsDir, 'android', 'tripo-app-signed.apk');
    if (fs.existsSync(signedApk)) {
      const sanitizedName = appName ? appName.replace(/[^a-z0-9-_]/gi, '_') : 'tripo-app';
      const destApkName = `${sanitizedName}-signed.apk`;
      const destApkPath = path.join(jobOutputsDir, destApkName);
      fs.copyFileSync(signedApk, destApkPath);
      artifacts.apk = `/api/download/${jobId}?file=apk`;
      artifactFiles.apk = destApkPath;
    }

    // Windows EXE / Setup
    const winSetup = path.join(distBuildsDir, 'windows', 'tripo-setup.exe');
    const winExe = path.join(distBuildsDir, 'windows', 'app.exe');
    if (fs.existsSync(winSetup)) {
      const sanitizedName = appName ? appName.replace(/[^a-z0-9-_]/gi, '_') : 'tripo';
      const destSetupName = `${sanitizedName}-setup.exe`;
      const destSetupPath = path.join(jobOutputsDir, destSetupName);
      fs.copyFileSync(winSetup, destSetupPath);
      artifacts.exe = `/api/download/${jobId}?file=exe`;
      artifactFiles.exe = destSetupPath;
    } else if (fs.existsSync(winExe)) {
      const sanitizedName = appName ? appName.replace(/[^a-z0-9-_]/gi, '_') : 'tripo-app';
      const destExeName = `${sanitizedName}.exe`;
      const destExePath = path.join(jobOutputsDir, destExeName);
      fs.copyFileSync(winExe, destExePath);
      artifacts.exe = `/api/download/${jobId}?file=exe`;
      artifactFiles.exe = destExePath;
    }

    // macOS DMG
    const macDir = path.join(distBuildsDir, 'mac');
    if (fs.existsSync(macDir)) {
      const destMacDir = path.join(jobOutputsDir, 'mac');
      copyRecursiveSync(macDir, destMacDir);
      artifacts.dmg = `/api/download/${jobId}?file=dmg`;
      artifactFiles.dmg = destMacDir;
    }

    // 7. Create all-in-one ZIP package
    const outputZip = new AdmZip();
    if (artifactFiles.apk) outputZip.addLocalFile(artifactFiles.apk);
    if (artifactFiles.exe) outputZip.addLocalFile(artifactFiles.exe);
    if (artifactFiles.dmg) {
      if (fs.statSync(artifactFiles.dmg).isFile()) {
        outputZip.addLocalFile(artifactFiles.dmg);
      } else {
        outputZip.addLocalFolder(artifactFiles.dmg, 'mac');
      }
    }

    const zipFilename = `${jobId}-outputs.zip`;
    const zipPathInJob = path.join(jobOutputsDir, zipFilename);
    const zipPathInDistBuilds = path.join(distBuildsDir, zipFilename);

    outputZip.writeZip(zipPathInJob);
    outputZip.writeZip(zipPathInDistBuilds);

    artifacts.zip = `/api/download/${jobId}`;
    artifactFiles.zip = zipPathInJob;

    const jobRecord = {
      jobId,
      status: 'completed',
      downloadUrl: `/api/download/${jobId}`,
      artifacts,
      artifactFiles,
      createdAt: new Date().toISOString()
    };

    jobsMap.set(jobId, jobRecord);

    console.log(`[JOB ${jobId}] Completed successfully! Artifacts generated:`, Object.keys(artifacts));

    return res.json({
      jobId,
      status: 'completed',
      downloadUrl: `/api/download/${jobId}`,
      artifacts
    });

  } catch (err) {
    console.error(`[JOB ${jobId}] Build error:`, err);
    // Cleanup upload files on error
    if (webBuildFile && fs.existsSync(webBuildFile.path)) fs.unlinkSync(webBuildFile.path);
    if (appLogoFile && fs.existsSync(appLogoFile.path)) fs.unlinkSync(appLogoFile.path);

    return res.status(500).json({
      status: 'failed',
      jobId,
      error: err.message || 'Build failed'
    });
  }
});

// Download Endpoint
app.get('/api/download/:jobId', (req, res) => {
  const { jobId } = req.params;
  const requestedFile = req.query.file;

  const jobRecord = jobsMap.get(jobId);
  const jobOutputsDir = path.join(jobsDir, jobId, 'outputs');
  const distBuildsZip = path.join(distBuildsDir, `${jobId}-outputs.zip`);

  if (!fs.existsSync(jobOutputsDir) && !fs.existsSync(distBuildsZip)) {
    return res.status(404).json({ error: `Job ${jobId} not found` });
  }

  let targetFilePath = null;
  let downloadFilename = null;

  if (!requestedFile || requestedFile === 'zip') {
    if (jobRecord && jobRecord.artifactFiles && jobRecord.artifactFiles.zip && fs.existsSync(jobRecord.artifactFiles.zip)) {
      targetFilePath = jobRecord.artifactFiles.zip;
    } else if (fs.existsSync(distBuildsZip)) {
      targetFilePath = distBuildsZip;
    } else if (fs.existsSync(jobOutputsDir)) {
      const files = fs.readdirSync(jobOutputsDir);
      const zFile = files.find(f => f.endsWith('.zip'));
      if (zFile) targetFilePath = path.join(jobOutputsDir, zFile);
    }
    downloadFilename = `${jobId}-outputs.zip`;
  } else if (requestedFile === 'apk') {
    if (jobRecord && jobRecord.artifactFiles && jobRecord.artifactFiles.apk && fs.existsSync(jobRecord.artifactFiles.apk)) {
      targetFilePath = jobRecord.artifactFiles.apk;
    } else if (fs.existsSync(jobOutputsDir)) {
      const files = fs.readdirSync(jobOutputsDir);
      const apk = files.find(f => f.endsWith('.apk'));
      if (apk) targetFilePath = path.join(jobOutputsDir, apk);
    }
  } else if (requestedFile === 'exe' || requestedFile === 'setup') {
    if (jobRecord && jobRecord.artifactFiles && jobRecord.artifactFiles.exe && fs.existsSync(jobRecord.artifactFiles.exe)) {
      targetFilePath = jobRecord.artifactFiles.exe;
    } else if (fs.existsSync(jobOutputsDir)) {
      const files = fs.readdirSync(jobOutputsDir);
      const exe = files.find(f => f.endsWith('.exe'));
      if (exe) targetFilePath = path.join(jobOutputsDir, exe);
    }
  } else if (requestedFile === 'dmg') {
    if (jobRecord && jobRecord.artifactFiles && jobRecord.artifactFiles.dmg && fs.existsSync(jobRecord.artifactFiles.dmg)) {
      targetFilePath = jobRecord.artifactFiles.dmg;
    } else if (fs.existsSync(jobOutputsDir)) {
      const files = fs.readdirSync(jobOutputsDir);
      const dmg = files.find(f => f.endsWith('.dmg'));
      if (dmg) targetFilePath = path.join(jobOutputsDir, dmg);
    }
  } else {
    // Explicit filename lookup
    const explicitPath = path.join(jobOutputsDir, requestedFile);
    if (fs.existsSync(explicitPath) && fs.statSync(explicitPath).isFile()) {
      targetFilePath = explicitPath;
    }
  }

  if (!targetFilePath || !fs.existsSync(targetFilePath) || !fs.statSync(targetFilePath).isFile()) {
    return res.status(404).json({ error: `File '${requestedFile || 'zip'}' for job ${jobId} not found` });
  }

  downloadFilename = downloadFilename || path.basename(targetFilePath);
  return res.download(path.resolve(targetFilePath), downloadFilename, { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) {
      console.error(`[DOWNLOAD ERROR] Failed to serve ${downloadFilename}:`, err);
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Tripo Web-to-App Cloud Converter Service Running   `);
  console.log(` Port: ${PORT}                                       `);
  console.log(` Dashboard: http://localhost:${PORT}/               `);
  console.log(` Health:    http://localhost:${PORT}/api/health     `);
  console.log(`====================================================`);
});
