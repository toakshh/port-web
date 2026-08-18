document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const healthBadge = document.getElementById('healthBadge');
  const healthStatusText = document.getElementById('healthStatusText');

  const convertForm = document.getElementById('convertForm');
  const webBuildInput = document.getElementById('webBuild');
  const dropZone = document.getElementById('dropZone');
  const dropZoneContent = document.getElementById('dropZoneContent');
  const fileInfo = document.getElementById('fileInfo');
  const fileNameDisplay = document.getElementById('fileName');
  const fileSizeDisplay = document.getElementById('fileSize');
  const btnRemoveFile = document.getElementById('btnRemoveFile');

  const appNameInput = document.getElementById('appName');
  const appIdentifierInput = document.getElementById('appIdentifier');
  const appLogoInput = document.getElementById('appLogo');
  const btnBrowseLogo = document.getElementById('btnBrowseLogo');
  const logoPreviewImg = document.getElementById('logoPreviewImg');
  const logoPlaceholder = document.getElementById('logoPlaceholder');
  const btnRemoveLogo = document.getElementById('btnRemoveLogo');

  const formSection = document.getElementById('formSection');
  const statusSection = document.getElementById('statusSection');
  const resultSection = document.getElementById('resultSection');

  const statusTitle = document.getElementById('statusTitle');
  const statusSubtitle = document.getElementById('statusSubtitle');
  const progressBar = document.getElementById('progressBar');

  const stepUpload = document.getElementById('stepUpload');
  const stepExtract = document.getElementById('stepExtract');
  const stepCompile = document.getElementById('stepCompile');
  const stepFinalize = document.getElementById('stepFinalize');

  const resJobId = document.getElementById('resJobId');
  const dlZipBtn = document.getElementById('dlZipBtn');
  const dlApkBtn = document.getElementById('dlApkBtn');
  const dlExeBtn = document.getElementById('dlExeBtn');
  const dlDmgBtn = document.getElementById('dlDmgBtn');
  const btnConvertAnother = document.getElementById('btnConvertAnother');

  // Check Health Endpoint
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        healthBadge.className = 'health-badge status-online';
        healthStatusText.textContent = 'API Online';
        healthBadge.title = `Capabilities: Android (${data.capabilities.android ? 'Yes' : 'No'}), Windows (${data.capabilities.windows ? 'Yes' : 'No'})`;
      } else {
        throw new Error('Health check failed');
      }
    } catch (err) {
      healthBadge.className = 'health-badge status-loading';
      healthStatusText.textContent = 'API Offline';
    }
  }
  checkHealth();

  // Drag and Drop Zip Upload Logic
  dropZone.addEventListener('click', (e) => {
    if (e.target !== btnRemoveFile) {
      webBuildInput.click();
    }
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.name.endsWith('.zip')) {
        webBuildInput.files = e.dataTransfer.files;
        handleFileSelect(file);
      } else {
        alert('Please upload a valid .zip file containing your web app build.');
      }
    }
  });

  webBuildInput.addEventListener('change', () => {
    if (webBuildInput.files && webBuildInput.files.length > 0) {
      handleFileSelect(webBuildInput.files[0]);
    }
  });

  function handleFileSelect(file) {
    fileNameDisplay.textContent = file.name;
    fileSizeDisplay.textContent = formatBytes(file.size);
    dropZoneContent.classList.add('hidden');
    fileInfo.classList.remove('hidden');
  }

  btnRemoveFile.addEventListener('click', (e) => {
    e.stopPropagation();
    webBuildInput.value = '';
    dropZoneContent.classList.remove('hidden');
    fileInfo.classList.add('hidden');
  });

  // App Logo Upload & Preview Logic
  btnBrowseLogo.addEventListener('click', () => appLogoInput.click());

  appLogoInput.addEventListener('change', () => {
    if (appLogoInput.files && appLogoInput.files.length > 0) {
      const logoFile = appLogoInput.files[0];
      const reader = new FileReader();
      reader.onload = (e) => {
        logoPreviewImg.src = e.target.result;
        logoPreviewImg.classList.remove('hidden');
        logoPlaceholder.classList.add('hidden');
        btnRemoveLogo.classList.remove('hidden');
      };
      reader.readAsDataURL(logoFile);
    }
  });

  btnRemoveLogo.addEventListener('click', () => {
    appLogoInput.value = '';
    logoPreviewImg.src = '';
    logoPreviewImg.classList.add('hidden');
    logoPlaceholder.classList.remove('hidden');
    btnRemoveLogo.classList.add('hidden');
  });

  // Helper byte format
  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // Form Submit Handler
  convertForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!webBuildInput.files || webBuildInput.files.length === 0) {
      alert('Please select a Web App Build (.zip) file.');
      return;
    }

    // Collect target checkboxes
    const targetBoxes = document.querySelectorAll('input[name="targets"]:checked');
    if (targetBoxes.length === 0) {
      alert('Please select at least one target platform.');
      return;
    }
    const targets = Array.from(targetBoxes).map(cb => cb.value).join(',');

    // Prepare FormData
    const formData = new FormData();
    formData.append('webBuild', webBuildInput.files[0]);
    if (appNameInput.value.trim()) formData.append('appName', appNameInput.value.trim());
    if (appIdentifierInput.value.trim()) formData.append('appIdentifier', appIdentifierInput.value.trim());
    if (appLogoInput.files && appLogoInput.files.length > 0) {
      formData.append('appLogo', appLogoInput.files[0]);
    }
    formData.append('targets', targets);

    // Transition UI to Progress
    formSection.classList.add('hidden');
    statusSection.classList.remove('hidden');
    resultSection.classList.add('hidden');

    resetProgressUI();

    // Start progress animation
    let currentProgress = 15;
    progressBar.style.width = `${currentProgress}%`;

    const progressTimer = setInterval(() => {
      if (currentProgress < 90) {
        currentProgress += Math.floor(Math.random() * 5) + 2;
        if (currentProgress > 90) currentProgress = 90;
        progressBar.style.width = `${currentProgress}%`;

        if (currentProgress > 25) setStepActive(stepExtract);
        if (currentProgress > 55) setStepActive(stepCompile);
        if (currentProgress > 80) setStepActive(stepFinalize);
      }
    }, 1500);

    try {
      const response = await fetch('/api/convert', {
        method: 'POST',
        body: formData
      });

      clearInterval(progressTimer);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Build request failed' }));
        throw new Error(errorData.error || `Server responded with status ${response.status}`);
      }

      const result = await response.json();

      progressBar.style.width = '100%';
      setStepActive(stepFinalize);

      setTimeout(() => {
        showResults(result);
      }, 600);

    } catch (err) {
      clearInterval(progressTimer);
      alert(`Conversion Failed: ${err.message}`);
      statusSection.classList.add('hidden');
      formSection.classList.remove('hidden');
    }
  });

  function resetProgressUI() {
    progressBar.style.width = '10%';
    [stepUpload, stepExtract, stepCompile, stepFinalize].forEach(step => {
      step.className = 'step-item';
    });
    stepUpload.className = 'step-item step-active';
  }

  function setStepActive(activeStep) {
    const steps = [stepUpload, stepExtract, stepCompile, stepFinalize];
    let found = false;
    steps.forEach(step => {
      if (step === activeStep) {
        found = true;
        step.className = 'step-item step-active';
      } else if (!found) {
        step.className = 'step-item step-done';
      } else {
        step.className = 'step-item';
      }
    });
  }

  function showResults(data) {
    statusSection.classList.add('hidden');
    resultSection.classList.remove('hidden');

    resJobId.textContent = data.jobId || 'N/A';
    dlZipBtn.href = data.downloadUrl || `/api/download/${data.jobId}`;

    // Reset individual buttons
    dlApkBtn.classList.add('hidden');
    dlExeBtn.classList.add('hidden');
    dlDmgBtn.classList.add('hidden');

    if (data.artifacts) {
      if (data.artifacts.apk) {
        dlApkBtn.href = data.artifacts.apk;
        dlApkBtn.classList.remove('hidden');
      }
      if (data.artifacts.exe) {
        dlExeBtn.href = data.artifacts.exe;
        dlExeBtn.classList.remove('hidden');
      }
      if (data.artifacts.dmg) {
        dlDmgBtn.href = data.artifacts.dmg;
        dlDmgBtn.classList.remove('hidden');
      }
    }
  }

  // Convert Another App Handler
  btnConvertAnother.addEventListener('click', () => {
    resultSection.classList.add('hidden');
    formSection.classList.remove('hidden');

    // Reset inputs
    webBuildInput.value = '';
    btnRemoveFile.click();
    btnRemoveLogo.click();
    appNameInput.value = '';
    appIdentifierInput.value = '';
  });
});
