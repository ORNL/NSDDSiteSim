const state = {
    cameras: [],
    rpms: [],
    rpmStatuses: {},
    files: [],
    filter: 'all'
};

// Keyed cache of `${type}-${id}` -> card HTMLElement. Persisting these across
// polls is what eliminates the flicker the old innerHTML-replace approach had.
const cardCache = new Map();

// Host used in user-visible URLs (RTSP cards, RPM TCP cards, CSV export). The
// downstream loader software expects the LXC IP, not whatever DNS name the
// admin happens to be browsing through, so this is intentionally hardcoded.
const DEVICE_HOST = '192.0.2.94';

let editingCameraId = null;
let editingRPMId = null;
let editingRPMConfig = null;

// ── Data fetching ────────────────────────────────────────────────────────────

async function fetchCameras() {
    try {
        const res = await fetch('/api/cameras');
        state.cameras = await res.json();
        renderDevices();
    } catch (e) {
        console.error('Failed to fetch cameras', e);
    }
}

async function fetchFiles() {
    try {
        const res = await fetch('/api/cameras/files');
        const data = await res.json();
        state.files = data.files;
        populateFiles();
    } catch (e) {
        console.error('Failed to fetch video files', e);
    }
}

async function fetchRPMs() {
    try {
        const res = await fetch('/api/rpms');
        state.rpms = await res.json();
        renderDevices();
    } catch (e) {
        console.error('Failed to fetch RPMs', e);
    }
}

async function fetchRPMStatuses() {
    for (const rpm of state.rpms) {
        if (!rpm.running) continue;
        try {
            const res = await fetch(`/api/rpms/${rpm.id}/status`);
            if (res.ok) {
                state.rpmStatuses[rpm.id] = await res.json();
            }
        } catch (e) {
            // non-critical, status display will just be stale
        }
    }
    renderDevices();
}

// ── Unified renderer ─────────────────────────────────────────────────────────

function passesFilter(item) {
    switch (state.filter) {
        case 'camera':  return item.type === 'camera';
        case 'rpm':     return item.type === 'rpm';
        case 'running': return item.data.running;
        default:        return true;
    }
}

function buildItems() {
    return [
        ...state.cameras.map(c => ({ type: 'camera', id: c.id, data: c })),
        ...state.rpms.map(r => ({
            type: 'rpm',
            id: r.id,
            data: r,
            status: state.rpmStatuses[r.id] || null,
        })),
    ];
}

function renderDevices() {
    const rpmCol = document.getElementById('rpm-column');
    const camCol = document.getElementById('camera-column');
    const all = buildItems();
    const items = all.filter(passesFilter);

    const rpmItems = items.filter(i => i.type === 'rpm');
    const camItems = items.filter(i => i.type === 'camera');

    document.getElementById('empty-rpms').style.display = rpmItems.length ? 'none' : '';
    document.getElementById('empty-cameras').style.display = camItems.length ? 'none' : '';

    const seen = new Set();
    renderColumn(rpmCol, rpmItems, seen);
    renderColumn(camCol, camItems, seen);

    // Drop cards for devices that no longer exist (or were filtered out).
    for (const [key, el] of cardCache) {
        if (!seen.has(key)) {
            el.remove();
            cardCache.delete(key);
        }
    }

    updateSummary(all);
}

function renderColumn(host, items, seen) {
    items.forEach((item, i) => {
        const key = `${item.type}-${item.id}`;
        seen.add(key);
        let el = cardCache.get(key);
        if (!el) {
            el = createCardElement(item);
            cardCache.set(key, el);
            host.appendChild(el);
        } else if (el.parentNode !== host) {
            // Card existed but is in the other column or detached — move it.
            host.appendChild(el);
        }
        updateCardElement(el, item);

        // Maintain DOM order within the column.
        const target = host.children[i];
        if (target !== el) host.insertBefore(el, target || null);
    });
}

function updateSummary(all) {
    const cams = all.filter(i => i.type === 'camera').length;
    const rpms = all.filter(i => i.type === 'rpm').length;
    const running = all.filter(i => i.data.running).length;
    document.getElementById('sum-cams').textContent = cams;
    document.getElementById('sum-rpms').textContent = rpms;
    document.getElementById('sum-running').textContent = running;
}

// ── Card construction (called once per device) ───────────────────────────────

function createCardElement(item) {
    const card = document.createElement('div');
    card.className = `card ${item.type}-card`;
    card.dataset.type = item.type;
    card.dataset.id = item.id;

    if (item.type === 'camera') {
        card.innerHTML = `
            <div class="card-header">
                <div class="stream-info">
                    <span class="status-chip" data-field="status-chip">
                        <span class="status-dot"></span><span data-field="status-label">Stopped</span>
                    </span>
                    <h3 data-field="name"></h3>
                </div>
                <div class="card-actions" data-field="actions"></div>
            </div>
            <div class="stream-details">
                <div>File: <span class="val" data-field="file"></span></div>
                <div>Port: <span class="val" data-field="port"></span></div>
                <div>Output: <span class="val" data-field="output"></span></div>
            </div>
            <div class="url-box" data-field="url"></div>
            <p class="url-hint">Click to copy RTSP URL</p>
        `;
    } else {
        card.innerHTML = `
            <div class="card-header">
                <div class="stream-info">
                    <span class="status-chip" data-field="status-chip">
                        <span class="status-dot"></span><span data-field="status-label">Stopped</span>
                    </span>
                    <h3 data-field="name"></h3>
                </div>
                <div class="card-actions" data-field="actions"></div>
            </div>
            <div class="stream-details">
                <div>Port: <span class="val" data-field="port"></span></div>
                <div>State: <span class="state-badge" data-field="state-badge"></span></div>
                <div>Connected Clients: <span class="val" data-field="clients"></span></div>
                <div>Occupancy Count: <span class="val" data-field="occ"></span></div>
                <div class="card-cameras" data-field="cameras"></div>
            </div>
            <div class="url-box" data-field="url"></div>
            <p class="url-hint">Click to copy TCP address</p>
        `;
    }

    // URL copy is the only inline behaviour; everything else is handled by the
    // delegated grid handler in init().
    card.querySelector('[data-field="url"]').addEventListener('click', e => {
        copyToClipboard(e.currentTarget, e.currentTarget.dataset.copy || e.currentTarget.textContent);
    });

    return card;
}

// ── Card update (called every poll, only writes when values changed) ─────────

function setText(el, field, value) {
    const node = el.querySelector(`[data-field="${field}"]`);
    if (node && node.textContent !== String(value)) node.textContent = value;
}

function setAttr(el, attr, value) {
    if (el.getAttribute(attr) !== String(value)) el.setAttribute(attr, value);
}

function updateCardElement(el, item) {
    const running = !!item.data.running;
    setAttr(el, 'data-running', running);

    setText(el, 'name', item.data.name || item.data.config?.name || '');
    setText(el, 'status-label', running ? 'Active' : 'Stopped');

    if (item.type === 'camera') {
        const cfg = item.data.config || {};
        const url = (item.data.url || '').replace('<host>', DEVICE_HOST);
        setText(el, 'file', cfg.video_file || '');
        setText(el, 'port', cfg.port ?? '');
        setText(el, 'output', `${cfg.resolution || 'Original'} @ ${cfg.framerate || 'Original'} FPS`);

        const urlBox = el.querySelector('[data-field="url"]');
        if (urlBox.textContent !== url) urlBox.textContent = url;
        urlBox.dataset.copy = url;

        renderActions(el, [
            running
                ? { action: 'stop', cls: 'btn-stop', title: 'Stop stream', svg: stopIcon() }
                : { action: 'start', cls: 'btn-play', title: 'Start stream', svg: playIcon() },
            !running ? { action: 'edit', cls: 'btn-edit', title: 'Edit settings', svg: editIcon() } : null,
            { action: 'delete', cls: '', title: 'Delete', svg: trashIcon() },
        ]);
    } else {
        const cfg = item.data.config || {};
        const status = item.status;
        const port = item.data.port ?? cfg.port ?? '';
        const tcpAddr = `tcp://${DEVICE_HOST}:${port}`;

        const hasAlarm = !!(status && (status.is_gamma_alarm || status.is_neutron_alarm));
        const stateLabel = status ? status.state : '—';
        const stateClass = hasAlarm ? 'ALARM' : (status ? status.state : 'IDLE');
        const alarmText = hasAlarm
            ? (status.is_gamma_alarm && status.is_neutron_alarm ? ' · γ+n ALARM'
               : status.is_gamma_alarm ? ' · γ ALARM'
               : ' · n ALARM')
            : '';

        setText(el, 'port', port);
        setText(el, 'clients', status ? status.connected_clients : '—');
        setText(el, 'occ', status ? status.occupancy_count : '—');

        // Associated cameras (chips). Names are looked up against state.cameras
        // so a deleted camera silently drops from the row.
        const camById = Object.fromEntries(state.cameras.map(c => [c.id, c]));
        const camIds = (cfg.camera_ids || []).filter(cid => camById[cid]);
        const camHost = el.querySelector('[data-field="cameras"]');
        const camSig = camIds.join(',');
        if (camHost.dataset.sig !== camSig) {
            camHost.dataset.sig = camSig;
            camHost.innerHTML = camIds.length
                ? '<span class="cam-label">📷 Cameras:</span> ' + camIds.map(cid =>
                    `<span class="cam-chip">${escHtml(camById[cid].config.name)}</span>`
                  ).join('')
                : '';
        }

        const stateBadge = el.querySelector('[data-field="state-badge"]');
        const stateText = `${stateLabel}${alarmText}`;
        if (stateBadge.textContent !== stateText) stateBadge.textContent = stateText;
        if (stateBadge.className !== `state-badge ${stateClass}`) {
            stateBadge.className = `state-badge ${stateClass}`;
        }

        const urlBox = el.querySelector('[data-field="url"]');
        if (urlBox.textContent !== tcpAddr) urlBox.textContent = tcpAddr;
        urlBox.dataset.copy = tcpAddr;

        // Stash current fault flags on the card so the click handler can
        // compute the toggle target without a separate fetch. Embedding the
        // active class in `cls` makes renderActions's signature-diff repaint
        // automatically when a fault toggles — no other plumbing needed.
        const fStatus = {
            gh:     status?.gh_fault     ? '1' : '0',
            gl:     status?.gl_fault     ? '1' : '0',
            nh:     status?.nh_fault     ? '1' : '0',
            tamper: status?.tamper_fault ? '1' : '0',
        };
        if (el.dataset.ghFault     !== fStatus.gh)     el.dataset.ghFault     = fStatus.gh;
        if (el.dataset.glFault     !== fStatus.gl)     el.dataset.glFault     = fStatus.gl;
        if (el.dataset.nhFault     !== fStatus.nh)     el.dataset.nhFault     = fStatus.nh;
        if (el.dataset.tamperFault !== fStatus.tamper) el.dataset.tamperFault = fStatus.tamper;
        const fActive = k => fStatus[k] === '1' ? ' active' : '';

        renderActions(el, running ? [
            { action: 'gamma',   cls: 'btn-gamma-alarm',   title: 'Trigger gamma alarm',   text: 'γ' },
            { action: 'neutron', cls: 'btn-neutron-alarm', title: 'Trigger neutron alarm', text: 'n' },
            { action: 'gh',      cls: `btn-fault btn-fault-gh${fActive('gh')}`,         title: 'Gamma High fault (toggle)',    text: 'GH' },
            { action: 'gl',      cls: `btn-fault btn-fault-gl${fActive('gl')}`,         title: 'Gamma Low fault (toggle)',     text: 'GL' },
            { action: 'nh',      cls: `btn-fault btn-fault-nh${fActive('nh')}`,         title: 'Neutron High fault (toggle)',  text: 'NH' },
            { action: 'tamper',  cls: `btn-fault btn-fault-tamper${fActive('tamper')}`, title: 'Tamper / power-fail (toggle)', text: 'T' },
            { action: 'stop',    cls: 'btn-stop',          title: 'Stop RPM',              svg: stopIcon() },
            { action: 'delete',  cls: '',                  title: 'Delete',                svg: trashIcon() },
        ] : [
            { action: 'start',  cls: 'btn-play btn-rpm-play', title: 'Start RPM',     svg: playIcon() },
            { action: 'edit',   cls: 'btn-edit btn-rpm-edit', title: 'Edit settings', svg: editIcon() },
            { action: 'delete', cls: '',                      title: 'Delete',        svg: trashIcon() },
        ]);
    }
}

function renderActions(el, actions) {
    const host = el.querySelector('[data-field="actions"]');
    // Compare a cheap signature so we only rebuild when the action set changes.
    const sig = actions.filter(Boolean).map(a => a.action + a.cls).join('|');
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    host.innerHTML = actions.filter(Boolean).map(a =>
        `<button class="btn-icon ${a.cls}" data-action="${a.action}" title="${escAttr(a.title)}">${a.text || a.svg}</button>`
    ).join('');
}

// ── Filter chips ─────────────────────────────────────────────────────────────

function setupFilterChips() {
    const bar = document.getElementById('filter-chips');
    bar.addEventListener('click', e => {
        const chip = e.target.closest('[data-filter]');
        if (!chip) return;
        bar.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
        state.filter = chip.dataset.filter;
        renderDevices();
    });
}

// ── Delegated grid click handler ─────────────────────────────────────────────

const cameraActions = {
    start:  startCamera,
    stop:   stopCamera,
    edit:   editCamera,
    delete: deleteCamera,
};
const rpmActions = {
    start:   startRPM,
    stop:    stopRPM,
    edit:    editRPM,
    delete:  deleteRPM,
    gamma:   id => triggerRPMAlarm(id, 'gamma'),
    neutron: id => triggerRPMAlarm(id, 'neutron'),
    // Fault toggles read current state from the card's dataset (stashed by
    // updateCardElement on each status poll) so a click flips to the inverse
    // without a fetch round-trip first.
    gh:      (id, card) => setRPMFault(id, 'gh',     card.dataset.ghFault     !== '1'),
    gl:      (id, card) => setRPMFault(id, 'gl',     card.dataset.glFault     !== '1'),
    nh:      (id, card) => setRPMFault(id, 'nh',     card.dataset.nhFault     !== '1'),
    tamper:  (id, card) => setRPMFault(id, 'tamper', card.dataset.tamperFault !== '1'),
};

function setupGridDelegation() {
    document.getElementById('device-layout').addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const card = btn.closest('[data-id]');
        if (!card) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        const action = btn.dataset.action;
        const handler = (type === 'camera' ? cameraActions : rpmActions)[action];
        if (handler) handler(id, card);
    });
}

// ── Video library ────────────────────────────────────────────────────────────

function openVideoLibrary() {
    renderVideoLibrary();
    showModal('video-modal-overlay', 'video-modal');
}

function closeVideoLibrary() {
    hideModal('video-modal-overlay', 'video-modal');
}

document.getElementById('video-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeVideoLibrary();
});

function renderVideoLibrary() {
    const list = document.getElementById('video-file-list');
    const inUse = new Set(state.cameras.map(c => c.config.video_file));

    if (state.files.length === 0) {
        list.innerHTML = '<div class="file-list-empty">No video files uploaded yet.</div>';
        return;
    }
    list.innerHTML = state.files.map(f => `
        <div class="file-list-item">
            <span class="file-name" title="${escAttr(f)}">${escHtml(f)}</span>
            ${inUse.has(f) ? '<span class="file-in-use">in use</span>' : ''}
            <button class="btn-icon" onclick="deleteVideoFile('${escAttr(f)}')"
                    title="${inUse.has(f) ? 'Cannot delete — file is in use' : 'Delete'}"
                    ${inUse.has(f) ? 'disabled style="opacity:0.3;cursor:not-allowed"' : ''}>
                ${trashIcon()}
            </button>
        </div>`).join('');
}

function handleDragOver(e) {
    e.preventDefault();
    document.getElementById('upload-zone').classList.add('dragover');
}

function handleDragLeave(e) {
    document.getElementById('upload-zone').classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    document.getElementById('upload-zone').classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) uploadVideoFile(file);
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) uploadVideoFile(file);
    e.target.value = '';  // reset so the same file can be re-selected
}

function uploadVideoFile(file) {
    const allowedExt = ['.mp4', '.mkv', '.avi'];
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!allowedExt.includes(ext)) {
        alert(`Unsupported file type "${ext}". Allowed: ${allowedExt.join(', ')}`);
        return;
    }

    const wrap = document.getElementById('upload-progress-wrap');
    const nameEl = document.getElementById('upload-progress-name');
    const pctEl = document.getElementById('upload-progress-pct');
    const bar = document.getElementById('upload-progress-bar-inner');

    wrap.style.display = 'block';
    nameEl.textContent = file.name;
    pctEl.textContent = '0%';
    bar.style.width = '0%';

    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/cameras/files');

    xhr.upload.onprogress = e => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            bar.style.width = pct + '%';
            pctEl.textContent = pct + '%';
        }
    };

    xhr.onload = async () => {
        wrap.style.display = 'none';
        if (xhr.status === 200) {
            await fetchFiles();
            // auto-select the newly uploaded file in the camera form
            const sel = document.getElementById('cam-video_file');
            const uploaded = JSON.parse(xhr.responseText).filename;
            if (sel) sel.value = uploaded;
            renderVideoLibrary();
        } else {
            let msg = 'Upload failed';
            try { msg = JSON.parse(xhr.responseText).detail; } catch (_) {}
            alert('Error: ' + msg);
        }
    };

    xhr.onerror = () => {
        wrap.style.display = 'none';
        alert('Upload failed — network error');
    };

    xhr.send(fd);
}

async function deleteVideoFile(filename) {
    if (!confirm(`Delete "${filename}"? This cannot be undone.`)) return;
    try {
        const res = await fetch(`/api/cameras/files/${encodeURIComponent(filename)}`, { method: 'DELETE' });
        if (res.ok) {
            await fetchFiles();
            renderVideoLibrary();
        } else {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
    } catch (e) {
        alert('Failed to delete file');
    }
}

// ── Camera modal ─────────────────────────────────────────────────────────────

function populateFiles() {
    const sel = document.getElementById('cam-video_file');
    sel.innerHTML = '<option value="">Select a video file...</option>' +
        state.files.map(f => `<option value="${escAttr(f)}">${escHtml(f)}</option>`).join('');
}

function openCameraModal(cam = null) {
    editingCameraId = cam ? cam.id : null;

    const modal = document.getElementById('camera-modal');
    const title = modal.querySelector('h2');
    const subtitle = modal.querySelector('.modal-subtitle');
    const submitBtn = modal.querySelector('[type="submit"]');

    if (cam) {
        title.textContent = 'Edit Camera Stream';
        subtitle.textContent = 'Update settings. Changes take effect when the stream is started.';
        submitBtn.textContent = 'Save Changes';

        populateFiles();
        document.getElementById('cam-name').value = cam.config.name;
        document.getElementById('cam-video_file').value = cam.config.video_file;
        document.getElementById('cam-port').value = cam.config.port;
        document.getElementById('cam-path').value = cam.config.path;
        document.getElementById('cam-resolution').value = cam.config.resolution || '';
        document.getElementById('cam-framerate').value = cam.config.framerate || '';
    } else {
        title.textContent = 'Add Camera Stream';
        subtitle.textContent = 'Configure a virtual IP camera (RTSP).';
        submitBtn.textContent = 'Start Stream';

        document.getElementById('camera-form').reset();
        const usedPorts = new Set([
            ...state.cameras.map(c => c.config.port),
            ...state.rpms.map(r => r.port)
        ]);
        let suggested = 9001;
        while (usedPorts.has(suggested)) suggested++;
        document.getElementById('cam-port').value = suggested;
    }

    showModal('camera-modal-overlay', 'camera-modal');
}

function closeCameraModal() {
    hideModal('camera-modal-overlay', 'camera-modal');
    editingCameraId = null;
}

document.getElementById('camera-form').onsubmit = async (e) => {
    e.preventDefault();
    const config = {
        name: document.getElementById('cam-name').value,
        video_file: document.getElementById('cam-video_file').value,
        port: parseInt(document.getElementById('cam-port').value),
        path: document.getElementById('cam-path').value,
        resolution: document.getElementById('cam-resolution').value || null,
        framerate: parseInt(document.getElementById('cam-framerate').value) || null
    };

    const url = editingCameraId ? `/api/cameras/${editingCameraId}` : '/api/cameras';
    const method = editingCameraId ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        if (res.ok) {
            closeCameraModal();
            document.getElementById('camera-form').reset();
            await fetchCameras();
        } else {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
    } catch (e) {
        alert('Failed to save camera stream');
    }
};

async function stopCamera(id) {
    try {
        const res = await fetch(`/api/cameras/${id}/stop`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
        await fetchCameras();
    } catch (e) {
        alert('Failed to stop camera');
    }
}

async function startCamera(id) {
    try {
        const res = await fetch(`/api/cameras/${id}/start`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
        await fetchCameras();
    } catch (e) {
        alert('Failed to start camera');
    }
}

function editCamera(id) {
    const cam = state.cameras.find(c => c.id === id);
    if (cam) openCameraModal(cam);
}

async function deleteCamera(id) {
    if (!confirm('Stop and remove this camera?')) return;
    try {
        await fetch(`/api/cameras/${id}`, { method: 'DELETE' });
        await fetchCameras();
    } catch (e) {
        alert('Failed to remove camera');
    }
}

// ── RPM modal ────────────────────────────────────────────────────────────────

function openRPMModal(rpm = null) {
    editingRPMId = rpm ? rpm.id : null;
    editingRPMConfig = rpm ? rpm.config : null;

    const modal = document.getElementById('rpm-modal');
    const title = modal.querySelector('h2');
    const subtitle = modal.querySelector('.modal-subtitle');
    const submitBtn = modal.querySelector('[type="submit"]');

    if (rpm) {
        title.textContent = 'Edit RPM Monitor';
        subtitle.textContent = 'Update settings. Changes take effect when the monitor is started.';
        submitBtn.textContent = 'Save Changes';

        const cfg = rpm.config;
        document.getElementById('rpm-name').value = cfg.name;
        document.getElementById('rpm-port').value = cfg.port;
        document.getElementById('rpm-unique_id').value = cfg.unique_id || '';
        document.getElementById('rpm-lane_width').value = cfg.lane_width ?? 4.7;
        document.getElementById('rpm-latitude').value = cfg.latitude ?? '';
        document.getElementById('rpm-longitude').value = cfg.longitude ?? '';
        document.getElementById('rpm-eml_enabled').checked = !!cfg.eml_enabled;
        document.getElementById('rpm-eml_collimated').checked = !!cfg.eml_collimated;
        renderCameraChecklist(cfg.camera_ids || []);
        document.getElementById('rpm-nominal_gamma_bg').value = cfg.nominal_gamma_bg;
        document.getElementById('rpm-nominal_neutron_bg').value = cfg.nominal_neutron_bg;
        document.getElementById('rpm-gamma_n_sigma').value = cfg.gamma_n_sigma;
        document.getElementById('rpm-neutron_n_sigma').value = cfg.neutron_n_sigma;
        document.getElementById('rpm-occupancy_frequency').value = cfg.occupancy_frequency;
        document.getElementById('rpm-occupancy_duration_range').value =
            Array.isArray(cfg.occupancy_duration_range)
                ? cfg.occupancy_duration_range.join(',')
                : cfg.occupancy_duration_range;
        document.getElementById('rpm-gamma_alarm_probability').value = cfg.gamma_alarm_probability;
        document.getElementById('rpm-neutron_alarm_probability').value = cfg.neutron_alarm_probability;
        document.getElementById('rpm-unique_alarm_probability').value = cfg.unique_alarm_probability;
    } else {
        title.textContent = 'Add RPM Monitor';
        subtitle.textContent = 'Configure a Rapiscan VM250 radiation portal monitor (TCP).';
        submitBtn.textContent = 'Start RPM';
        editingRPMConfig = null;

        document.getElementById('rpm-form').reset();
        const usedPorts = new Set([
            ...state.cameras.map(c => c.config.port),
            ...state.rpms.map(r => r.port)
        ]);
        let suggested = 10001;
        while (usedPorts.has(suggested)) suggested++;
        document.getElementById('rpm-port').value = suggested;

        // Suggest the next NSDDn id (NSDD1, NSDD2, ...) skipping ones in use.
        const usedIds = new Set(state.rpms.map(r => r.config.unique_id).filter(Boolean));
        let n = 1;
        while (usedIds.has(`NSDD${n}`)) n++;
        document.getElementById('rpm-unique_id').value = `NSDD${n}`;
        document.getElementById('rpm-lane_width').value = 4.7;
        renderCameraChecklist([]);
    }

    showModal('rpm-modal-overlay', 'rpm-modal');
}

function renderCameraChecklist(selectedIds) {
    const host = document.getElementById('rpm-cameras-list');
    if (!state.cameras.length) {
        host.innerHTML = '<div class="checklist-empty">No cameras configured yet.</div>';
        return;
    }
    const sel = new Set(selectedIds);
    host.innerHTML = state.cameras.map(c => `
        <label class="checklist-item">
            <input type="checkbox" value="${escAttr(c.id)}" ${sel.has(c.id) ? 'checked' : ''}>
            <span class="checklist-name">${escHtml(c.config.name)}</span>
            <span class="checklist-meta">:${c.config.port}/${escHtml(c.config.path)}</span>
        </label>
    `).join('');
}

function closeRPMModal() {
    hideModal('rpm-modal-overlay', 'rpm-modal');
    editingRPMId = null;
    editingRPMConfig = null;
}

document.getElementById('rpm-form').onsubmit = async (e) => {
    e.preventDefault();
    const durationRaw = document.getElementById('rpm-occupancy_duration_range').value;
    const parts = durationRaw.split(',').map(s => parseInt(s.trim()));
    const duration = (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]))
        ? parts : [6, 10];

    const cameraIds = Array.from(
        document.querySelectorAll('#rpm-cameras-list input[type="checkbox"]:checked')
    ).map(el => el.value);

    const latRaw = document.getElementById('rpm-latitude').value;
    const lonRaw = document.getElementById('rpm-longitude').value;

    const config = {
        name: document.getElementById('rpm-name').value,
        port: parseInt(document.getElementById('rpm-port').value),
        nominal_gamma_bg: parseFloat(document.getElementById('rpm-nominal_gamma_bg').value),
        nominal_neutron_bg: parseFloat(document.getElementById('rpm-nominal_neutron_bg').value),
        gamma_n_sigma: parseFloat(document.getElementById('rpm-gamma_n_sigma').value),
        neutron_n_sigma: parseFloat(document.getElementById('rpm-neutron_n_sigma').value),
        occupancy_frequency: parseFloat(document.getElementById('rpm-occupancy_frequency').value),
        occupancy_duration_range: duration,
        gamma_alarm_probability: parseFloat(document.getElementById('rpm-gamma_alarm_probability').value),
        neutron_alarm_probability: parseFloat(document.getElementById('rpm-neutron_alarm_probability').value),
        unique_alarm_probability: parseFloat(document.getElementById('rpm-unique_alarm_probability').value),
        unique_id: document.getElementById('rpm-unique_id').value.trim(),
        latitude: latRaw === '' ? null : parseFloat(latRaw),
        longitude: lonRaw === '' ? null : parseFloat(lonRaw),
        eml_enabled: document.getElementById('rpm-eml_enabled').checked,
        eml_collimated: document.getElementById('rpm-eml_collimated').checked,
        lane_width: parseFloat(document.getElementById('rpm-lane_width').value) || 4.7,
        camera_ids: cameraIds,
    };

    // Preserve fields not shown in the form when editing
    if (editingRPMConfig) {
        config.point_source_sigma = editingRPMConfig.point_source_sigma;
        config.distributed_source_sigma = editingRPMConfig.distributed_source_sigma;
        config.source_pos_length = editingRPMConfig.source_pos_length;
        config.source_pos_width = editingRPMConfig.source_pos_width;
        config.source_pos_height = editingRPMConfig.source_pos_height;
        config.is_distributed = editingRPMConfig.is_distributed;
    }

    const url = editingRPMId ? `/api/rpms/${editingRPMId}` : '/api/rpms';
    const method = editingRPMId ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        if (res.ok) {
            closeRPMModal();
            document.getElementById('rpm-form').reset();
            await fetchRPMs();
        } else {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
    } catch (e) {
        alert('Failed to save RPM');
    }
};

async function triggerRPMAlarm(id, type) {
    const gamma = type === 'gamma' || type === 'both';
    const neutron = type === 'neutron' || type === 'both';
    try {
        const res = await fetch(`/api/rpms/${id}/trigger?gamma=${gamma}&neutron=${neutron}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
    } catch (e) {
        alert('Failed to trigger alarm');
    }
}

// Toggle a manual fault state. `type` is 'gh' | 'gl' | 'nh' | 'tamper';
// `active` is the desired new state. The next /status poll (≤3s) reconciles
// the button's active highlight via the dataset flags stashed in
// updateCardElement — no optimistic UI needed for testing-grade snappiness.
async function setRPMFault(id, type, active) {
    try {
        const res = await fetch(`/api/rpms/${id}/fault?type=${type}&active=${active}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
    } catch (e) {
        alert('Failed to toggle fault');
    }
}

async function stopRPM(id) {
    try {
        const res = await fetch(`/api/rpms/${id}/stop`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
        await fetchRPMs();
    } catch (e) {
        alert('Failed to stop RPM');
    }
}

async function startRPM(id) {
    try {
        const res = await fetch(`/api/rpms/${id}/start`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + err.detail);
        }
        await fetchRPMs();
    } catch (e) {
        alert('Failed to start RPM');
    }
}

function editRPM(id) {
    const rpm = state.rpms.find(r => r.id === id);
    if (rpm) openRPMModal(rpm);
}

async function deleteRPM(id) {
    if (!confirm('Stop and remove this RPM monitor?')) return;
    try {
        await fetch(`/api/rpms/${id}`, { method: 'DELETE' });
        delete state.rpmStatuses[id];
        await fetchRPMs();
    } catch (e) {
        alert('Failed to remove RPM');
    }
}

// ── Modal helpers ────────────────────────────────────────────────────────────

function showModal(overlayId, modalId) {
    const overlay = document.getElementById(overlayId);
    overlay.style.display = 'flex';
    setTimeout(() => {
        overlay.style.opacity = '1';
        document.getElementById(modalId).classList.add('active');
    }, 10);
}

function hideModal(overlayId, modalId) {
    const overlay = document.getElementById(overlayId);
    overlay.style.opacity = '0';
    document.getElementById(modalId).classList.remove('active');
    setTimeout(() => { overlay.style.display = 'none'; }, 300);
}

// Close modals on overlay click
document.getElementById('camera-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeCameraModal();
});
document.getElementById('rpm-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeRPMModal();
});

// ── CSV export ───────────────────────────────────────────────────────────────

// Generates a site-config CSV in the format the external loader software
// expects. Columns and field order match the example provided by the user.
// Per-camera columns repeat as CameraType{i},CameraHost{i},CameraPath{i},
// Codec{i},Username{i},Password{i} — the row width is sized to the RPM with
// the most associated cameras; rows with fewer cameras pad with blanks.
function exportCSV() {
    if (!state.rpms.length) {
        alert('No RPMs configured — nothing to export.');
        return;
    }
    const camById = Object.fromEntries(state.cameras.map(c => [c.id, c]));
    const host = DEVICE_HOST;

    const rpmsExpanded = state.rpms.map(rpm => {
        const cfg = rpm.config || {};
        const cams = (cfg.camera_ids || []).map(id => camById[id]).filter(Boolean);
        return { rpm, cfg, cams };
    });
    // The downstream loader requires CameraType0/CameraHost0/CameraPath0/Codec0/
    // Username0/Password0 to be present unconditionally — clamp to at least one
    // camera slot so the columns always appear even with zero associations.
    const maxCams = Math.max(
        1,
        rpmsExpanded.reduce((m, r) => Math.max(m, r.cams.length), 0)
    );

    const baseHeader = [
        'Name', 'UniqueID', 'AutoStart', 'Latitude', 'Longitude',
        'RPMConfigType', 'RPMHost', 'RPMPort',
        'AspectAddressStart', 'AspectAddressEnd',
        'EMLEnabled', 'EMLCollimated', 'LaneWidth',
    ];
    const camHeader = i => [
        `CameraType${i}`, `CameraHost${i}`, `CameraPath${i}`,
        `Codec${i}`, `Username${i}`, `Password${i}`,
    ];
    const header = [...baseHeader];
    for (let i = 0; i < maxCams; i++) header.push(...camHeader(i));

    const rows = rpmsExpanded.map(({ rpm, cfg, cams }) => {
        const row = [
            cfg.name || '',
            cfg.unique_id || '',
            'true',
            cfg.latitude == null ? '' : cfg.latitude,
            cfg.longitude == null ? '' : cfg.longitude,
            'Rapiscan',
            host,
            rpm.port ?? cfg.port ?? '',
            '',  // AspectAddressStart
            '',  // AspectAddressEnd
            cfg.eml_enabled ? 'true' : 'false',
            cfg.eml_collimated ? 'true' : 'false',
            cfg.lane_width ?? 4.7,
        ];
        for (let i = 0; i < maxCams; i++) {
            const cam = cams[i];
            if (cam) {
                row.push('Custom', host, `:${cam.config.port}/${cam.config.path}`, '', '', '');
            } else {
                row.push('', '', '', '', '', '');
            }
        }
        return row;
    });

    const csvEscape = v => {
        const s = String(v ?? '');
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [header, ...rows]
        .map(r => r.map(csvEscape).join(','))
        .join('\r\n') + '\r\n';

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lanesim-config.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Utilities ────────────────────────────────────────────────────────────────

function copyToClipboard(el, text) {
    navigator.clipboard.writeText(text).then(() => {
        const orig = el.textContent;
        el.textContent = 'Copied!';
        el.style.color = 'var(--accent)';
        setTimeout(() => {
            el.textContent = orig;
            el.style.color = '';
        }, 2000);
    });
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escAttr(str) {
    return String(str).replace(/"/g, '&quot;');
}

function trashIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
    </svg>`;
}

function playIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <polygon points="5 3 19 12 5 21 5 3"/>
    </svg>`;
}

function stopIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
    </svg>`;
}

function editIcon() {
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>`;
}

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    setupFilterChips();
    setupGridDelegation();

    await Promise.all([fetchCameras(), fetchRPMs(), fetchFiles()]);

    setInterval(fetchCameras, 5000);
    setInterval(async () => {
        await fetchRPMs();
        await fetchRPMStatuses();
    }, 3000);
}

init();
