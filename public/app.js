document.addEventListener('DOMContentLoaded', () => {
  const $ = (id) => document.getElementById(id);

  // DOM Elements
  const healthBadge = $('healthBadge');
  const healthStatusText = $('healthStatusText');

  const convertForm = $('convertForm');
  const webBuildInput = $('webBuild');
  const dropZone = $('dropZone');
  const dropZoneContent = $('dropZoneContent');
  const fileInfo = $('fileInfo');
  const fileNameDisplay = $('fileName');
  const fileSizeDisplay = $('fileSize');
  const btnRemoveFile = $('btnRemoveFile');

  const appNameInput = $('appName');
  const appIdentifierInput = $('appIdentifier');
  const appLogoInput = $('appLogo');
  const btnBrowseLogo = $('btnBrowseLogo');
  const logoPreviewImg = $('logoPreviewImg');
  const logoPlaceholder = $('logoPlaceholder');
  const btnRemoveLogo = $('btnRemoveLogo');

  const appSplashInput = $('appSplash');
  const splashColorInput = $('splashColor');
  const btnBrowseSplash = $('btnBrowseSplash');
  const splashPreviewImg = $('splashPreviewImg');
  const splashPlaceholder = $('splashPlaceholder');
  const btnRemoveSplash = $('btnRemoveSplash');

  const formSection = $('formSection');
  const statusSection = $('statusSection');
  const resultSection = $('resultSection');

  const statusTitle = $('statusTitle');
  const statusSubtitle = $('statusSubtitle');
  const progressBar = $('progressBar');
  const progressText = $('progressText');
  const progressTiming = $('progressTiming');
  const logOutput = $('logOutput');
  const liveJobId = $('liveJobId');
  const btnCancelWatch = $('btnCancelWatch');

  const fastEta = $('fastEta');
  const cleanEta = $('cleanEta');
  const modeEtaNote = $('modeEtaNote');

  const steps = {
    upload: $('stepUpload'),
    extract: $('stepExtract'),
    compile: $('stepCompile'),
    finalize: $('stepFinalize')
  };

  const resJobId = $('resJobId');
  const resultNote = $('resultNote');
  const downloadButtons = {
    zip: $('dlZipBtn'),
    apk: $('dlApkBtn'),
    exe: $('dlExeBtn'),
    setup: $('dlSetupBtn'),
    dmg: $('dlDmgBtn'),
    ios: $('dlIosBtn')
  };
  const btnConvertAnother = $('btnConvertAnother');
  const btnSubmit = $('btnSubmit');

  let pollTimer = null;
  let watching = null;

  /* --------------------------- job handshake ------------------------- */

  // The server issues a per-job token exactly once, in the /api/convert
  // response. Every later request about that job has to present it, which is
  // what stops one client from polling or downloading another's build. It is
  // kept in sessionStorage so a page reload does not orphan a running job.
  const tokens = {
    read() {
      try {
        return JSON.parse(sessionStorage.getItem('tripoJobTokens') || '{}');
      } catch (_) {
        return {};
      }
    },
    save(jobId, token) {
      if (!jobId || !token) return;
      const all = this.read();
      all[jobId] = token;
      try {
        sessionStorage.setItem('tripoJobTokens', JSON.stringify(all));
      } catch (_) {
        /* private browsing - the in-page copy still works for this visit */
      }
    },
    get(jobId) {
      return this.read()[jobId] || null;
    }
  };

  /** fetch() for a job-scoped endpoint. */
  function jobFetch(jobId, url, options = {}) {
    return fetch(url, options);
  }

  /** A download URL for <a href>. */
  function jobDownloadUrl(jobId, url) {
    return url;
  }

  const btnLock = $('btnLock');
  if (btnLock) {
    btnLock.addEventListener('click', async () => {
      await fetch('/api/dashboard/logout', { method: 'POST' }).catch(() => {});
      location.replace('/login');
    });
  }

  /* ----------------------------- health ----------------------------- */

  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error('health check failed');
      const data = await res.json();
      const caps = data.capabilities || {};
      const buildable = ['android', 'windows', 'mac', 'ios'].filter((k) => caps[k]);

      healthBadge.classList.remove('status-loading', 'status-online', 'status-degraded');
      healthBadge.classList.add(buildable.length ? 'status-online' : 'status-degraded');
      healthStatusText.textContent = buildable.length
        ? `API Online — ${buildable.join(', ')}`
        : 'API Online — no build toolchain';
      healthBadge.title = buildable.length
        ? `This host can build: ${buildable.join(', ')}`
        : 'No target can be built on this host. Run "npm run doctor" on the server for the missing pieces.';

      // Disable targets this host cannot produce, so nobody waits for a build
      // that was never going to work.
      document.querySelectorAll('input[name="targets"]').forEach((box) => {
        const supported =
          (box.value === 'android' && caps.android) ||
          ((box.value === 'exe' || box.value === 'windows') && caps.windows) ||
          (box.value === 'mac' && caps.mac) ||
          (box.value === 'ios' && caps.ios);
        box.disabled = !supported;
        const card = box.closest('.target-card');
        if (card) {
          card.classList.toggle('target-unavailable', !supported);
          card.title = supported ? '' : 'Not available on this server';
        }
        if (!supported) box.checked = false;
      });
      // Target availability may have just changed what is selected.
      refreshEstimates();
    } catch (err) {
      healthBadge.classList.remove('status-online', 'status-degraded');
      healthBadge.classList.add('status-loading');
      healthStatusText.textContent = 'API Offline';
    }
  }
  checkHealth();

  /* --------------------------- file pickers -------------------------- */

  dropZone.addEventListener('click', (e) => {
    if (e.target !== btnRemoveFile) webBuildInput.click();
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

  let selectedWebBuildFile = null;

  webBuildInput.addEventListener('change', () => {
    if (webBuildInput.files && webBuildInput.files[0]) {
      selectedWebBuildFile = webBuildInput.files[0];
      handleFileSelect(selectedWebBuildFile);
    }
  });

  const webBuildFolderInput = $('webBuildFolder');
  if (webBuildFolderInput) {
    webBuildFolderInput.addEventListener('change', async () => {
      const files = webBuildFolderInput.files;
      if (!files || files.length === 0) return;
      
      showStatus();
      statusTitle.textContent = 'Zipping folder...';
      progressTiming.textContent = 'Creating zip archive from selected folder...';
      
      try {
        const zip = new JSZip();
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          const path = file.webkitRelativePath || file.name;
          const parts = path.split('/');
          if (parts.length > 1) parts.shift(); // remove root dir name
          zip.file(parts.join('/'), file);
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        selectedWebBuildFile = new File([blob], "upload.zip", { type: "application/zip" });
        handleFileSelect(selectedWebBuildFile);
      } catch(err) {
        alert("Failed to compress folder.");
      } finally {
        backToForm();
      }
    });
  }

  async function getFilesFromEntry(entry) {
    if (entry.isFile) {
      return new Promise((resolve) => entry.file(f => resolve({ path: entry.fullPath.replace(/^\//, ''), file: f })));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let allEntries = [];
      let readEntries = async () => {
        return new Promise((resolve) => {
          reader.readEntries(async (entries) => {
            if (entries.length === 0) resolve([]);
            else resolve(entries.concat(await readEntries()));
          });
        });
      };
      const entries = await readEntries();
      let files = [];
      for (const e of entries) {
        files = files.concat(await getFilesFromEntry(e));
      }
      return files;
    }
    return [];
  }

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    
    // Check if folder was dropped
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      const item = e.dataTransfer.items[0].webkitGetAsEntry();
      if (item && item.isDirectory) {
        showStatus();
        statusTitle.textContent = 'Zipping folder...';
        progressTiming.textContent = 'Creating zip archive from dropped folder...';
        try {
          const zip = new JSZip();
          for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const currentItem = e.dataTransfer.items[i].webkitGetAsEntry();
            if (!currentItem) continue;
            const files = await getFilesFromEntry(currentItem);
            for (const { path, file } of files) {
              const parts = path.split('/');
              if (parts.length > 1 && currentItem.isDirectory) parts.shift();
              zip.file(parts.join('/'), file);
            }
          }
          const blob = await zip.generateAsync({ type: 'blob' });
          selectedWebBuildFile = new File([blob], "upload.zip", { type: "application/zip" });
          handleFileSelect(selectedWebBuildFile);
        } catch(err) {
          alert("Failed to compress folder.");
        } finally {
          backToForm();
        }
        return;
      }
    }

    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      alert('Please upload a .zip archive containing your web app build.');
      return;
    }
    selectedWebBuildFile = file;
    handleFileSelect(file);
  });

  function handleFileSelect(file) {
    fileNameDisplay.textContent = file.name;
    fileSizeDisplay.textContent = formatBytes(file.size);
    dropZoneContent.classList.add('hidden');
    fileInfo.classList.remove('hidden');
    refreshEstimates();
  }

  btnRemoveFile.addEventListener('click', (e) => {
    e.stopPropagation();
    webBuildInput.value = '';
    if (webBuildFolderInput) webBuildFolderInput.value = '';
    selectedWebBuildFile = null;
    dropZoneContent.classList.remove('hidden');
    fileInfo.classList.add('hidden');
    hideEstimates();
  });

  btnBrowseLogo.addEventListener('click', () => appLogoInput.click());

  appLogoInput.addEventListener('change', () => {
    const logoFile = appLogoInput.files && appLogoInput.files[0];
    if (!logoFile) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      logoPreviewImg.src = e.target.result;
      logoPreviewImg.classList.remove('hidden');
      logoPlaceholder.classList.add('hidden');
      btnRemoveLogo.classList.remove('hidden');
    };
    reader.readAsDataURL(logoFile);
  });

  btnRemoveLogo.addEventListener('click', () => {
    appLogoInput.value = '';
    logoPreviewImg.src = '';
    logoPreviewImg.classList.add('hidden');
    logoPlaceholder.classList.remove('hidden');
    btnRemoveLogo.classList.add('hidden');
  });

  if (btnBrowseSplash && appSplashInput) {
    btnBrowseSplash.addEventListener('click', () => appSplashInput.click());

    appSplashInput.addEventListener('change', () => {
      const splashFile = appSplashInput.files && appSplashInput.files[0];
      if (!splashFile) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        splashPreviewImg.src = e.target.result;
        splashPreviewImg.classList.remove('hidden');
        splashPlaceholder.classList.add('hidden');
        btnRemoveSplash.classList.remove('hidden');
      };
      reader.readAsDataURL(splashFile);
    });

    btnRemoveSplash.addEventListener('click', () => {
      appSplashInput.value = '';
      splashPreviewImg.src = '';
      splashPreviewImg.classList.add('hidden');
      splashPlaceholder.classList.remove('hidden');
      btnRemoveSplash.classList.add('hidden');
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }

  /* ---------------------------- estimates ---------------------------- */

  const selectedTargets = () =>
    Array.from(document.querySelectorAll('input[name="targets"]:checked')).map((cb) => cb.value);

  function hideEstimates() {
    fastEta.hidden = true;
    cleanEta.hidden = true;
    modeEtaNote.classList.add('hidden');
  }

  /**
   * Ask the server how long each mode is likely to take for the chosen targets.
   * The server bases this on how long previous builds on this host actually
   * took, so it gets sharper with use rather than being a fixed guess.
   */
  async function refreshEstimates() {
    const hasFile = selectedWebBuildFile != null;
    const targets = selectedTargets();
    if (!hasFile || targets.length === 0) {
      hideEstimates();
      return;
    }

    try {
      const res = await fetch(`/api/estimate?targets=${encodeURIComponent(targets.join(','))}`);
      if (!res.ok) throw new Error('estimate unavailable');
      const data = await res.json();

      const show = (el, info) => {
        el.textContent = `~${info.human}`;
        el.title =
          info.basis === 'measured'
            ? `Median of the last ${info.samples} builds on this server`
            : info.samples > 0
              ? `Based on ${info.samples} previous build(s) plus a default estimate`
              : 'Default estimate - no builds recorded on this server yet';
        el.classList.toggle('mode-eta-measured', info.basis === 'measured');
        el.hidden = false;
      };
      show(fastEta, data.fast);
      show(cleanEta, data.clean);

      const notes = [];
      if (data.fast.samples === 0 && data.clean.samples === 0) {
        notes.push('Times are rough defaults until this server has completed a few builds.');
      }
      if (!data.cacheWarm) {
        notes.push('No compilation cache yet, so the first fast build costs about as much as a clean one.');
      }
      if (data.queueAheadSeconds > 0) {
        notes.push(
          `Builds run one at a time — about ${formatDuration(data.queueAheadSeconds)} of work is ahead of you.`
        );
      }

      modeEtaNote.textContent = notes.join(' ');
      modeEtaNote.classList.toggle('hidden', notes.length === 0);
    } catch (err) {
      hideEstimates();
    }
  }

  document.querySelectorAll('input[name="targets"]').forEach((box) => {
    box.addEventListener('change', refreshEstimates);
  });

  /* ------------------------------ submit ----------------------------- */

  convertForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!selectedWebBuildFile) {
      alert('Please select a Web App Build (.zip or folder).');
      return;
    }

    const targetBoxes = document.querySelectorAll('input[name="targets"]:checked');
    if (targetBoxes.length === 0) {
      alert('Please select at least one target platform that this server can build.');
      return;
    }

    const mode = (document.querySelector('input[name="buildMode"]:checked') || {}).value || 'fast';

    const formData = new FormData();
    formData.append('webBuild', selectedWebBuildFile);
    formData.append('targets', Array.from(targetBoxes).map((cb) => cb.value).join(','));
    formData.append('mode', mode);
    if (appNameInput.value.trim()) formData.append('appName', appNameInput.value.trim());
    if (appIdentifierInput.value.trim()) formData.append('appIdentifier', appIdentifierInput.value.trim());
    if (appLogoInput.files && appLogoInput.files[0]) formData.append('appLogo', appLogoInput.files[0]);
    if (appSplashInput && appSplashInput.files && appSplashInput.files[0]) formData.append('appSplash', appSplashInput.files[0]);
    if (splashColorInput && splashColorInput.value) formData.append('splashColor', splashColorInput.value);

    showStatus();
    btnSubmit.disabled = true;

    try {
      const response = await fetch('/api/convert', {
        method: 'POST',
        headers: {
          'X-Converter-Token': 'DRRJLpHH0aShP63mK0Phej3kpkMBbKTS3do1GSkAZMdIb7BSb4t1htoaLwZHTs5F'
        },
        body: formData
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok && response.status !== 202) {
        throw new Error(body.error || `Server responded with status ${response.status}`);
      }

      watching = body.jobId;
      liveJobId.textContent = body.jobId;
      statusSubtitle.textContent =
        mode === 'fast'
          ? 'Swapping static/files into the shared app shell and compiling incrementally.'
          : 'Rebuilding everything from your upload; the shared baseline will be updated on success.';
      pollJob(body.jobId);
    } catch (err) {
      stopPolling();
      alert(`Conversion failed: ${err.message}`);
      backToForm();
    } finally {
      btnSubmit.disabled = false;
    }
  });

  /* ------------------------------ polling ---------------------------- */

  function pollJob(jobId) {
    stopPolling();
    let ticks = 0;

    const tick = async () => {
      if (watching !== jobId) return;
      ticks++;
      try {
        const [job, logs] = await Promise.all([
          jobFetch(jobId, `/api/jobs/${jobId}`).then((r) => r.json()),
          jobFetch(jobId, `/api/jobs/${jobId}/log`).then((r) => r.json()).catch(() => null)
        ]);

        if (logs && Array.isArray(logs.lines) && logs.lines.length > 0) {
          logOutput.textContent = logs.lines.slice(-200).join('\n');
          logOutput.scrollTop = logOutput.scrollHeight;
        }

        applyStage(job);

        if (job.status === 'completed') {
          stopPolling();
          setProgress(100);
          progressTiming.textContent = `Finished in ${formatDuration(job.durationSeconds || job.elapsedSeconds || 0)}`;
          markStep('finalize', 'done');
          setTimeout(() => showResults(job), 500);
          return;
        }
        if (job.status === 'failed') {
          stopPolling();
          showFailure(job);
          return;
        }
      } catch (err) {
        // A transient network blip should not kill the watcher.
      }
      pollTimer = setTimeout(tick, 1500);
    };

    tick();
  }

  function setProgress(percent) {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    progressBar.style.width = `${clamped}%`;
    progressText.textContent = `${clamped}%`;
  }

  function applyStage(job) {
    // The server computes progress and ETA from the recorded duration of past
    // builds, so every client shows the same honest number.
    setProgress(job.progress != null ? job.progress : 5);

    const elapsed = formatDuration(job.elapsedSeconds || 0);
    if (job.status === 'queued') {
      statusTitle.textContent = job.queuePosition
        ? `Queued — position ${job.queuePosition}`
        : 'Queued...';
      progressTiming.textContent = 'Waiting for the build queue';
      markStep('upload', 'active');
      return;
    }

    statusTitle.textContent = 'Converting Web App...';

    if (job.etaSeconds != null) {
      const overrun = job.estimate && job.elapsedSeconds > job.estimate.seconds;
      progressTiming.textContent = overrun
        ? `Elapsed ${elapsed} — taking longer than the ${formatDuration(job.estimate.seconds)} estimate`
        : `Elapsed ${elapsed} — about ${formatDuration(job.etaSeconds)} left`;
    } else {
      progressTiming.textContent = `Elapsed ${elapsed}`;
    }

    const stage = job.stage || job.status;
    if (stage === 'extract') markStep('extract', 'active');
    else if (stage === 'build') markStep('compile', 'active');
    else if (stage === 'package' || stage === 'done') markStep('finalize', 'active');
    else markStep('upload', 'active');
  }

  function markStep(key, state) {
    const order = ['upload', 'extract', 'compile', 'finalize'];
    const index = order.indexOf(key);
    order.forEach((name, i) => {
      const el = steps[name];
      if (!el) return;
      el.classList.remove('step-done', 'step-active');
      if (i < index) el.classList.add('step-done');
      else if (i === index) el.classList.add(`step-${state === 'done' ? 'done' : 'active'}`);
    });
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  /* ------------------------------ views ------------------------------ */

  function showStatus() {
    formSection.classList.add('hidden');
    resultSection.classList.add('hidden');
    statusSection.classList.remove('hidden');
    progressBar.classList.remove('progress-failed');
    setProgress(2);
    progressTiming.textContent = 'Uploading...';
    logOutput.textContent = 'Uploading...';
    liveJobId.textContent = '';
    statusTitle.textContent = 'Uploading web build...';
    markStep('upload', 'active');
  }

  function backToForm() {
    watching = null;
    stopPolling();
    statusSection.classList.add('hidden');
    resultSection.classList.add('hidden');
    formSection.classList.remove('hidden');
  }

  btnCancelWatch.addEventListener('click', backToForm);

  function showFailure(job) {
    const detail = [job.error, ...(job.buildFailures || [])].filter(Boolean).join('\n');
    alert(`Conversion failed:\n\n${detail || 'Unknown error'}\n\nThe full build log is shown on the page.`);
    statusTitle.textContent = 'Conversion failed';
    statusSubtitle.textContent = job.error || 'See the build log below.';
    setProgress(100);
    progressTiming.textContent = `Failed after ${formatDuration(job.durationSeconds || job.elapsedSeconds || 0)}`;
    progressBar.classList.add('progress-failed');
  }

  function showResults(job) {
    watching = null;
    statusSection.classList.add('hidden');
    resultSection.classList.remove('hidden');
    progressBar.classList.remove('progress-failed');

    resJobId.textContent = job.jobId || 'N/A';
    downloadButtons.zip.href = jobDownloadUrl(job.jobId, job.downloadUrl || `/api/download/${job.jobId}`);

    const took = job.durationSeconds || job.elapsedSeconds;
    const resDuration = $('resDuration');
    if (resDuration) {
      resDuration.textContent = took
        ? `Built in ${formatDuration(took)} (${job.mode === 'clean' ? 'clean rebuild' : 'fast hot-swap'})`
        : '';
    }

    const artifacts = job.artifacts || {};
    for (const [key, button] of Object.entries(downloadButtons)) {
      if (key === 'zip' || !button) continue;
      if (artifacts[key]) {
        button.href = jobDownloadUrl(job.jobId, artifacts[key]);
        button.classList.remove('hidden');
      } else {
        button.classList.add('hidden');
      }
    }

    // Be explicit when some requested target did not make it.
    if (job.buildFailures && job.buildFailures.length > 0) {
      resultNote.textContent = `Some targets did not complete: ${job.buildFailures.join('; ')}`;
      resultNote.classList.remove('hidden');
    } else {
      resultNote.classList.add('hidden');
    }
  }

  btnConvertAnother.addEventListener('click', () => {
    backToForm();
    webBuildInput.value = '';
    if (webBuildFolderInput) webBuildFolderInput.value = '';
    selectedWebBuildFile = null;
    dropZoneContent.classList.remove('hidden');
    fileInfo.classList.add('hidden');
    appLogoInput.value = '';
    logoPreviewImg.src = '';
    logoPreviewImg.classList.add('hidden');
    logoPlaceholder.classList.remove('hidden');
    btnRemoveLogo.classList.add('hidden');
    if (appSplashInput) {
      appSplashInput.value = '';
      splashPreviewImg.src = '';
      splashPreviewImg.classList.add('hidden');
      splashPlaceholder.classList.remove('hidden');
      btnRemoveSplash.classList.add('hidden');
    }
    if (splashColorInput) splashColorInput.value = '#ffffff';
    appNameInput.value = '';
    appIdentifierInput.value = '';
    hideEstimates();
    checkHealth();
  });
});
