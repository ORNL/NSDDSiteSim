const state = {
    cameras: [],
    rpms: [],
    mobiles: [],
    rpmStatuses: {},
    mobileStatuses: {},
    files: [],
    isotopes: [],
    // The service's wall clock — traffic profiles key off it, not the browser's
    // timezone, so the schedule editor labels its hour axis with this.
    serverClock: null,
    filter: 'all'
};

// Default patrol route: the four-gate Arlington loop from the RS-350/D5 spec.
// The D5 walks it reversed so two walkers on defaults separate visually.
const DEFAULT_MOBILE_ROUTE = [
    [38.88340, -77.06653],
    [38.87890, -77.06580],
    [38.87310, -77.06520],
    [38.86782, -77.06666],
    [38.86940, -77.07230],
    [38.87678, -77.07849],
    [38.88210, -77.07360],
    [38.88773, -77.06768],
    [38.88560, -77.06600],
];

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
let editingMobileId = null;

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

async function fetchServerClock() {
    try {
        const res = await fetch('/api/rpms/clock');
        if (res.ok) state.serverClock = await res.json();
    } catch (e) {
        // non-critical — the schedule editor just omits the timezone label
    }
}

async function fetchMobiles() {
    try {
        const res = await fetch('/api/mobiles');
        state.mobiles = await res.json();
        renderDevices();
    } catch (e) {
        console.error('Failed to fetch mobile detectors', e);
    }
}

async function fetchMobileStatuses() {
    for (const mob of state.mobiles) {
        if (!mob.running) continue;
        try {
            const res = await fetch(`/api/mobiles/${mob.id}/status`);
            if (res.ok) {
                state.mobileStatuses[mob.id] = await res.json();
            }
        } catch (e) {
            // non-critical, status display will just be stale
        }
    }
    renderDevices();
}

async function fetchIsotopes() {
    try {
        const res = await fetch('/api/mobiles/isotopes');
        const data = await res.json();
        state.isotopes = data.isotopes;
    } catch (e) {
        console.error('Failed to fetch isotope list', e);
    }
}

// ── Unified renderer ─────────────────────────────────────────────────────────

function passesFilter(item) {
    switch (state.filter) {
        case 'camera':  return item.type === 'camera';
        case 'rpm':     return item.type === 'rpm';
        case 'mobile':  return item.type === 'mobile';
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
        ...state.mobiles.map(m => ({
            type: 'mobile',
            id: m.id,
            data: m,
            status: state.mobileStatuses[m.id] || null,
        })),
    ];
}

function renderDevices() {
    const rpmCol = document.getElementById('rpm-column');
    const mobileCol = document.getElementById('mobile-column');
    const camCol = document.getElementById('camera-column');
    const all = buildItems();
    const items = all.filter(passesFilter);

    const rpmItems = items.filter(i => i.type === 'rpm');
    const mobileItems = items.filter(i => i.type === 'mobile');
    const camItems = items.filter(i => i.type === 'camera');

    document.getElementById('empty-rpms').style.display = rpmItems.length ? 'none' : '';
    document.getElementById('empty-mobiles').style.display = mobileItems.length ? 'none' : '';
    document.getElementById('empty-cameras').style.display = camItems.length ? 'none' : '';

    const seen = new Set();
    renderColumn(rpmCol, rpmItems, seen);
    renderColumn(mobileCol, mobileItems, seen);
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
    const mobiles = all.filter(i => i.type === 'mobile').length;
    const running = all.filter(i => i.data.running).length;
    document.getElementById('sum-cams').textContent = cams;
    document.getElementById('sum-rpms').textContent = rpms;
    document.getElementById('sum-mobiles').textContent = mobiles;
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
    } else if (item.type === 'rpm') {
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
                <div class="card-rate" data-field="rate-row" hidden>Traffic Now: <span class="val" data-field="rate"></span></div>
                <div class="card-cameras" data-field="cameras"></div>
            </div>
            <div class="url-box" data-field="url"></div>
            <p class="url-hint">Click to copy TCP address</p>
        `;
    } else {
        card.innerHTML = `
            <div class="card-header">
                <div class="stream-info">
                    <span class="status-chip" data-field="status-chip">
                        <span class="status-dot"></span><span data-field="status-label">Stopped</span>
                    </span>
                    <h3 data-field="name"></h3>
                    <span class="type-badge" data-field="type-badge"></span>
                </div>
                <div class="card-actions" data-field="actions"></div>
            </div>
            <div class="stream-details">
                <div>Port: <span class="val" data-field="port"></span></div>
                <div>State: <span class="state-badge" data-field="state-badge"></span></div>
                <div>Position: <span class="val" data-field="position"></span></div>
                <div>Connected Clients: <span class="val" data-field="clients"></span></div>
                <div>Alarm Episodes: <span class="val" data-field="alarms"></span></div>
                <div>Battery: <span class="val" data-field="battery"></span></div>
                <div>Profile: <span class="val" data-field="profile"></span></div>
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
    } else if (item.type === 'rpm') {
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

        // Live traffic rate, shown only when a profile is driving this lane —
        // it's the quickest confirmation the schedule is actually in force.
        const schedOn = !!cfg.occupancy_schedule_enabled;
        const rateRow = el.querySelector('[data-field="rate-row"]');
        if (rateRow.hidden !== !schedOn) rateRow.hidden = !schedOn;
        if (schedOn) {
            if (status) {
                const pEff = status.occupancy_frequency_effective ?? 0;
                const dr = cfg.occupancy_duration_range;
                const meanDur = Array.isArray(dr) ? (dr[0] + dr[1]) / 2 : 8;
                const mult = cfg.occupancy_frequency ? pEff / cfg.occupancy_frequency : 1;
                setText(el, 'rate', `${occVehPerHour(pEff, meanDur).toFixed(0)} veh/hr (×${mult.toFixed(2)})`);
            } else {
                setText(el, 'rate', '—');
            }
        }

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
    } else {
        const cfg = item.data.config || {};
        // Ignore a cached status once the detector is stopped — otherwise the
        // card keeps showing the walker's last position as if it were live.
        const status = item.data.running ? item.status : null;
        const port = item.data.port ?? cfg.port ?? '';
        const tcpAddr = `tcp://${DEVICE_HOST}:${port}`;
        const typeLabel = (item.data.detector_type || cfg.detector_type) === 'd5'
            ? 'Kromek D5' : 'RS-350';

        setText(el, 'type-badge', typeLabel);
        setText(el, 'port', port);
        setText(el, 'clients', status ? status.connected_clients : '—');
        setText(el, 'alarms', status ? status.alarm_count : '—');
        setText(el, 'battery', status ? `${status.battery_pct.toFixed(0)}%` : '—');
        setText(el, 'position', status
            ? `${status.latitude.toFixed(5)}, ${status.longitude.toFixed(5)}`
            : '—');

        const intervalMin = (cfg.alarm_interval_s || 0) / 60;
        const intervalText = intervalMin > 0 ? `alarm ~${intervalMin} min` : 'manual alarms';
        setText(el, 'profile', `${cfg.speed_mps} m/s · ${cfg.isotope} · ${intervalText}`);

        const alarming = !!(status && status.alarming);
        const stateBadge = el.querySelector('[data-field="state-badge"]');
        const stateText = !status ? '—'
            : alarming ? `ALARM · ${status.isotope}` : 'WALKING';
        const stateClass = alarming ? 'ALARM' : 'WALKING';
        if (stateBadge.textContent !== stateText) stateBadge.textContent = stateText;
        if (stateBadge.className !== `state-badge ${stateClass}`) {
            stateBadge.className = `state-badge ${stateClass}`;
        }

        const urlBox = el.querySelector('[data-field="url"]');
        if (urlBox.textContent !== tcpAddr) urlBox.textContent = tcpAddr;
        urlBox.dataset.copy = tcpAddr;

        renderActions(el, running ? [
            { action: 'trigger', cls: 'btn-trigger-alarm', title: 'Trigger alarm episode', text: '☢' },
            { action: 'stop',    cls: 'btn-stop',          title: 'Stop mobile detector',  svg: stopIcon() },
            { action: 'delete',  cls: '',                  title: 'Delete',                svg: trashIcon() },
        ] : [
            { action: 'start',  cls: 'btn-play btn-mobile-play', title: 'Start mobile detector', svg: playIcon() },
            { action: 'edit',   cls: 'btn-edit btn-mobile-edit', title: 'Edit settings',         svg: editIcon() },
            { action: 'delete', cls: '',                         title: 'Delete',                svg: trashIcon() },
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
const mobileActions = {
    start:   startMobile,
    stop:    stopMobile,
    edit:    editMobile,
    delete:  deleteMobile,
    trigger: triggerMobileAlarm,
};
const actionMaps = { camera: cameraActions, rpm: rpmActions, mobile: mobileActions };

function setupGridDelegation() {
    document.getElementById('device-layout').addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const card = btn.closest('[data-id]');
        if (!card) return;
        const id = card.dataset.id;
        const type = card.dataset.type;
        const action = btn.dataset.action;
        const handler = (actionMaps[type] || {})[action];
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
        loadOccupancySchedule(cfg);
        // Don't let a configured traffic profile hide inside a collapsed section.
        modal.querySelector('details.advanced').open = !!cfg.occupancy_schedule_enabled;
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
        // form.reset() clears the checkbox but not occHours/occDays, so without
        // this an Add straight after an Edit inherits the previous lane's curve.
        loadOccupancySchedule(null);
        document.querySelectorAll('#occ-presets .chip').forEach(c => c.classList.remove('active'));
        modal.querySelector('details.advanced').open = false;
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
        occupancy_schedule_enabled: occEnabled(),
        occupancy_hour_factors: occHours.slice(),
        occupancy_day_factors: occDays.slice(),
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
            // The traffic-profile arrays are pydantic-validated, so a 422 here
            // arrives as a list of error objects — flatten it or it renders as
            // "[object Object]".
            const err = await res.json();
            alert('Error: ' + formatApiError(err));
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

// ── RPM traffic profile editor ───────────────────────────────────────────────
// Working copy + dirty flag, the same shape as the Leaflet route editor below:
// occHours/occDays are the source of truth while the modal is open, the bar
// chart and the comma-separated text field are two views onto them, and only
// the submit handler serialises. form.reset() does NOT clear these — the add
// branch of openRPMModal must call loadOccupancySchedule(null) explicitly.

const OCC_MAX = 3.0;      // mirrors models.OCC_FACTOR_MAX — keep the two in sync
const OCC_STEP = 0.1;
const OCC_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const OCC_PRESETS = {
    flat: new Array(24).fill(1),
    commuter: [0.1, 0.05, 0.05, 0.05, 0.1, 0.3, 0.8, 2.0, 2.5, 1.8, 1.1, 1.0,
               1.1, 1.0, 1.0, 1.2, 2.0, 2.4, 1.6, 0.9, 0.6, 0.4, 0.25, 0.15],
    business: [0, 0, 0, 0, 0, 0.1, 0.3, 0.8, 1.4, 1.5, 1.4, 1.3,
               1.2, 1.3, 1.4, 1.4, 1.2, 0.7, 0.2, 0.05, 0, 0, 0, 0],
    port: [0.7, 0.6, 0.55, 0.5, 0.55, 0.7, 0.9, 1.2, 1.4, 1.4, 1.3, 1.2,
           1.2, 1.3, 1.4, 1.4, 1.3, 1.1, 1.0, 0.95, 0.9, 0.85, 0.8, 0.75],
};

const OCC_PRESET_DAYS = {
    flat:     [1, 1, 1, 1, 1, 1, 1],
    commuter: [1, 1, 1, 1, 1, 0.55, 0.35],
    business: [1, 1, 1, 1, 1, 0.3, 0.1],
    port:     [1, 1, 1, 1, 1, 0.9, 0.8],
};

let occHours = new Array(24).fill(1);
let occDays = new Array(7).fill(1);
let occPainting = false;
let occFocusHour = null;   // hovered/painted hour driving the live readout
let occPreviewDay = 0;     // weekday the stats footer reports on

// The trailing toFixed matters: Math.round(v / 0.1) * 0.1 yields 0.30000000000000004,
// which would be what lands in rpms.json.
const occClamp = v => +(Math.round(Math.min(OCC_MAX, Math.max(0, v)) / OCC_STEP) * OCC_STEP).toFixed(2);
const occEnabled = () => document.getElementById('rpm-occupancy_schedule_enabled').checked;
const occBaseP = () => parseFloat(document.getElementById('rpm-occupancy_frequency').value) || 0;

function occMeanDuration() {
    const p = document.getElementById('rpm-occupancy_duration_range')
        .value.split(',').map(s => parseFloat(s.trim()));
    const [a, b] = (p.length === 2 && p.every(n => !isNaN(n))) ? p : [6, 10];
    return (a + b) / 2;
}

// Raw product before clamping — anything over 1.0 is a silent no-op in the sim.
const occRawP = (h, wd) => occBaseP() * occHours[h] * occDays[wd];
const occEffectiveP = (h, wd) => Math.min(1, Math.max(0, occRawP(h, wd)));

// A full arrival cycle is 5/p seconds of idle rolls plus one transit, because
// the simulator only rolls from IDLE — the transit is dead time. That's why
// p=1.0 tops out near 277 veh/hr at an 8s mean transit, not 720.
const occVehPerHour = (p, meanDur) => (p <= 0 ? 0 : 3600 / (5 / p + meanDur));

function buildOccChart() {
    const host = document.getElementById('occ-hour-chart');
    if (host.childElementCount) return;
    // type="button" is load-bearing: a bare <button> in a <form> submits it.
    host.innerHTML = Array.from({ length: 24 }, (_, h) =>
        `<button type="button" class="occ-bar" data-hour="${h}"><span class="occ-bar-fill"></span></button>`
    ).join('');

    host.addEventListener('pointerdown', occPaintStart);
    host.addEventListener('pointermove', occPaintMove);
    host.addEventListener('pointerleave', () => { occFocusHour = null; updateOccStats(); });
    host.addEventListener('keydown', occBarKey);
    // No setPointerCapture — capture retargets later events to the captured
    // element, which is exactly what breaks painting *across* bars. Track the
    // drag release on window instead.
    window.addEventListener('pointerup', () => { occPainting = false; });
    window.addEventListener('pointercancel', () => { occPainting = false; });
}

// elementFromPoint rather than event.target: under touch, events stay pinned to
// the element the gesture started on, so delegation alone can't paint a drag.
function occPaintAt(clientX, clientY) {
    const bar = document.elementFromPoint(clientX, clientY)?.closest('.occ-bar');
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    occHours[+bar.dataset.hour] = occClamp((1 - (clientY - r.top) / r.height) * OCC_MAX);
    occFocusHour = +bar.dataset.hour;
    renderOccChart();
}

function occPaintStart(e) {
    if (!occEnabled()) return;
    occPainting = true;
    occPaintAt(e.clientX, e.clientY);
    e.preventDefault();   // no text selection, no touch scroll mid-drag
}

function occPaintMove(e) {
    if (!occEnabled()) return;
    if (occPainting) { occPaintAt(e.clientX, e.clientY); return; }
    const bar = e.target.closest('.occ-bar');
    const h = bar ? +bar.dataset.hour : null;
    if (h !== occFocusHour) { occFocusHour = h; updateOccStats(); }
}

function occBarKey(e) {
    const bar = e.target.closest('.occ-bar');
    if (!bar) return;
    const d = e.key === 'ArrowUp' ? OCC_STEP : e.key === 'ArrowDown' ? -OCC_STEP : 0;
    if (!d) return;
    e.preventDefault();
    const h = +bar.dataset.hour;
    occHours[h] = occClamp(occHours[h] + d);
    occFocusHour = h;
    renderOccChart();
}

function renderOccChart() {
    const wd = occPreviewDay;
    const meanDur = occMeanDuration();
    const nowHour = state.serverClock ? state.serverClock.hour : null;

    document.getElementById('occ-hour-chart').querySelectorAll('.occ-bar').forEach(bar => {
        const h = +bar.dataset.hour;
        const v = occHours[h];
        const height = `${(v / OCC_MAX) * 100}%`;
        const fill = bar.firstElementChild;
        if (fill.style.height !== height) fill.style.height = height;
        bar.classList.toggle('is-zero', v === 0);
        bar.classList.toggle('is-clamped', occRawP(h, wd) > 1.0);
        bar.classList.toggle('is-now', h === nowHour);
        // Guarded like setText — this runs on every pointermove during a drag.
        const title = `${String(h).padStart(2, '0')}:00 — ×${v.toFixed(1)} → `
            + `${occVehPerHour(occEffectiveP(h, wd), meanDur).toFixed(0)} veh/hr`;
        if (bar.title !== title) bar.title = title;
    });

    const raw = document.getElementById('rpm-occ-hours-raw');
    const serialised = occHours.map(v => v.toFixed(1)).join(',');
    if (document.activeElement !== raw && raw.value !== serialised) raw.value = serialised;

    renderOccDayRow();
    updateOccStats();
}

function renderOccDayRow() {
    const host = document.getElementById('occ-day-row');
    if (!host.childElementCount) {
        host.innerHTML = OCC_DAYS.map((d, i) => `
            <label class="occ-day" data-day="${i}"><span>${escHtml(d)}</span>
                <input type="number" data-day="${i}" step="0.1" min="0" max="${OCC_MAX}">
            </label>`).join('');
        host.addEventListener('input', e => {
            const el = e.target.closest('input[data-day]');
            if (!el) return;
            occDays[+el.dataset.day] = occClamp(parseFloat(el.value) || 0);
            renderOccChart();
        });
        // Focusing a day switches which weekday the readout describes.
        host.addEventListener('focusin', e => {
            const el = e.target.closest('input[data-day]');
            if (el) { occPreviewDay = +el.dataset.day; renderOccChart(); }
        });
    }
    host.querySelectorAll('input[data-day]').forEach(el => {
        // Never rewrite the focused input's value — it resets the caret mid-type.
        if (document.activeElement !== el) el.value = occDays[+el.dataset.day].toFixed(1);
    });
    host.querySelectorAll('label[data-day]').forEach(el => {
        el.classList.toggle('is-preview', +el.dataset.day === occPreviewDay);
    });
}

function updateOccStats() {
    const el = document.getElementById('occ-sched-stats');
    const wd = occPreviewDay;
    const meanDur = occMeanDuration();
    const tz = state.serverClock ? ` ${state.serverClock.timezone}` : '';

    if (!occEnabled()) {
        const r = occVehPerHour(Math.min(1, occBaseP()), meanDur);
        el.textContent = `Flat — ${r.toFixed(0)} veh/hr · ~${Math.round(r * 24).toLocaleString()} veh/day`;
        return;
    }
    if (occFocusHour !== null) {
        const h = occFocusHour;
        const p = occEffectiveP(h, wd);
        el.textContent = `${String(h).padStart(2, '0')}:00${tz} ${OCC_DAYS[wd]} — `
            + `×${occHours[h].toFixed(1)} · p=${p.toFixed(3)} · ${occVehPerHour(p, meanDur).toFixed(0)} veh/hr`
            + (occRawP(h, wd) > 1.0 ? ' — clamped at p=1.0' : '');
        return;
    }
    const rates = occHours.map((_, h) => occVehPerHour(occEffectiveP(h, wd), meanDur));
    const total = Math.round(rates.reduce((a, b) => a + b, 0));
    const clamped = occHours.some((_, h) => occRawP(h, wd) > 1.0);
    el.textContent = `${OCC_DAYS[wd]}: ~${total.toLocaleString()} veh/day · `
        + `peak ${Math.max(...rates).toFixed(0)} veh/hr`
        + (clamped ? ' · some hours clamped at p=1.0' : '');
}

function loadOccupancySchedule(cfg) {
    const ok = (a, n) => Array.isArray(a) && a.length === n;
    document.getElementById('rpm-occupancy_schedule_enabled').checked =
        !!(cfg && cfg.occupancy_schedule_enabled);
    occHours = ok(cfg && cfg.occupancy_hour_factors, 24)
        ? cfg.occupancy_hour_factors.map(occClamp) : new Array(24).fill(1);
    occDays = ok(cfg && cfg.occupancy_day_factors, 7)
        ? cfg.occupancy_day_factors.map(occClamp) : new Array(7).fill(1);
    occFocusHour = null;
    // Server weekday if we have it, else convert the browser's (JS 0=Sun -> 0=Mon).
    occPreviewDay = state.serverClock ? state.serverClock.wday : (new Date().getDay() + 6) % 7;
    buildOccChart();
    syncOccEnabled();
    renderOccChart();
}

function resetOccupancySchedule() {
    occHours = new Array(24).fill(1);
    occDays = new Array(7).fill(1);
    document.querySelectorAll('#occ-presets .chip').forEach(c => c.classList.remove('active'));
    renderOccChart();
}

function syncOccEnabled() {
    document.getElementById('occ-sched-body').classList.toggle('is-disabled', !occEnabled());
}

document.getElementById('rpm-occupancy_schedule_enabled').addEventListener('change', () => {
    syncOccEnabled();
    renderOccChart();
});
document.getElementById('rpm-occupancy_frequency').addEventListener('input', renderOccChart);
document.getElementById('rpm-occupancy_duration_range').addEventListener('input', updateOccStats);

document.getElementById('occ-presets').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const key = chip.dataset.preset;
    occHours = OCC_PRESETS[key].slice();
    occDays = OCC_PRESET_DAYS[key].slice();
    document.querySelectorAll('#occ-presets .chip').forEach(c => c.classList.toggle('active', c === chip));
    // Picking a preset implies you want the profile on.
    if (!occEnabled()) {
        document.getElementById('rpm-occupancy_schedule_enabled').checked = true;
        syncOccEnabled();
    }
    renderOccChart();
});

// The text field is the escape hatch the chart can't be: exact values, copy a
// profile between lanes, paste one from a spreadsheet. Same "min,max" precedent
// as the Occupancy Duration input above it.
document.getElementById('rpm-occ-hours-raw').addEventListener('change', e => {
    const parts = e.target.value.split(',').map(s => parseFloat(s.trim()));
    if (parts.length !== 24 || parts.some(isNaN)) {
        alert(`Enter exactly 24 comma-separated numbers between 0 and ${OCC_MAX}.`);
        renderOccChart();   // rewrite the canonical value back
        return;
    }
    occHours = parts.map(occClamp);
    renderOccChart();
});

// Advanced Settings is collapsed by default, and a native validation failure on
// an input inside it blocks submit with a bubble the browser can't show. Pop it
// open instead — same fix the mobile form already has.
document.getElementById('rpm-form').addEventListener('invalid', () => {
    document.querySelector('#rpm-modal details.advanced').open = true;
}, true);

// ── Mobile detector modal + Leaflet route editor ─────────────────────────────

let mobileMap = null;          // lazy Leaflet singleton (created on first modal open)
let routeLatLngs = [];         // [{lat, lng}, ...] working copy for the editor
let routeMarkers = [];
let routePolyline = null;
let routeDirty = false;        // user has touched the route (type switch won't reset it)
let mobilePortAuto = true;     // port still holds an auto-suggested value

function defaultRouteForType(type) {
    const r = DEFAULT_MOBILE_ROUTE.map(p => [p[0], p[1]]);
    return type === 'd5' ? r.reverse() : r;
}

function ensureMobileMap() {
    const host = document.getElementById('mobile-map');
    if (typeof L === 'undefined') {
        if (!host.querySelector('.map-unavailable')) {
            host.innerHTML = '<div class="map-unavailable">Map unavailable — the browser could not load ' +
                'Leaflet from unpkg.com. The route below is kept as-is; other fields still work.</div>';
        }
        return false;
    }
    if (mobileMap) return true;

    mobileMap = L.map('mobile-map');
    const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
    });
    const sat = L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Esri World Imagery',
    });
    osm.addTo(mobileMap);
    L.control.layers({ 'Map': osm, 'Satellite': sat }).addTo(mobileMap);
    mobileMap.on('click', e => {
        routeLatLngs.push({ lat: e.latlng.lat, lng: e.latlng.lng });
        routeDirty = true;
        rebuildRouteLayer();
    });
    return true;
}

function waypointIcon(n) {
    return L.divIcon({
        className: 'wp-icon',
        html: `<div class="wp-dot">${n}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
    });
}

function rebuildRouteLayer() {
    updateRouteStats();
    if (!mobileMap) return;
    routeMarkers.forEach(m => m.remove());
    routeMarkers = [];
    routeLatLngs.forEach((ll, i) => {
        const m = L.marker([ll.lat, ll.lng], { icon: waypointIcon(i + 1), draggable: true });
        m.on('drag', e => {
            const p = e.target.getLatLng();
            routeLatLngs[i] = { lat: p.lat, lng: p.lng };
            updateRoutePolyline();
            updateRouteStats();
        });
        m.on('dragend', () => { routeDirty = true; });
        // Leaflet suppresses click after a drag, so click-to-remove is safe.
        const remove = () => {
            routeLatLngs.splice(i, 1);
            routeDirty = true;
            rebuildRouteLayer();
        };
        m.on('click', remove);
        m.on('contextmenu', remove);
        m.addTo(mobileMap);
        routeMarkers.push(m);
    });
    updateRoutePolyline();
}

function updateRoutePolyline() {
    if (!mobileMap) return;
    const pts = routeLatLngs.map(ll => [ll.lat, ll.lng]);
    const closed = pts.length >= 2 ? pts.concat([pts[0]]) : pts;  // show loop closure
    if (!routePolyline) {
        routePolyline = L.polyline(closed, { color: '#a855f7', weight: 3, opacity: 0.9 }).addTo(mobileMap);
    } else {
        routePolyline.setLatLngs(closed);
    }
}

function routeLengthMeters() {
    let total = 0;
    const n = routeLatLngs.length;
    for (let i = 0; i < n; i++) {
        const a = routeLatLngs[i], b = routeLatLngs[(i + 1) % n];
        const dy = (b.lat - a.lat) * 111320;
        const dx = (b.lng - a.lng) * 111320 * Math.cos(a.lat * Math.PI / 180);
        total += Math.hypot(dx, dy);
    }
    return total;
}

function updateRouteStats() {
    const el = document.getElementById('route-stats');
    const n = routeLatLngs.length;
    if (n < 2) {
        el.textContent = `${n} waypoint${n === 1 ? '' : 's'} — add at least 2`;
        return;
    }
    const len = routeLengthMeters();
    const speed = parseFloat(document.getElementById('mobile-speed_mps').value) || 1.4;
    const lapS = len / speed;
    const mm = Math.floor(lapS / 60);
    const ss = String(Math.round(lapS % 60)).padStart(2, '0');
    el.textContent = `${n} waypoints · ${(len / 1000).toFixed(2)} km loop · lap ~${mm}:${ss} at ${speed} m/s`;
}

function loadRouteIntoEditor(route) {
    routeLatLngs = route.map(p => ({ lat: p[0], lng: p[1] }));
    rebuildRouteLayer();
    fitMobileMapToRoute();
}

function fitMobileMapToRoute() {
    if (!mobileMap) return;
    if (routeLatLngs.length >= 2) {
        mobileMap.fitBounds(L.latLngBounds(routeLatLngs.map(ll => [ll.lat, ll.lng])), { padding: [25, 25] });
    } else {
        mobileMap.setView([38.8778, -77.0712], 14);  // Arlington site
    }
}

function resetMobileRoute() {
    routeDirty = false;
    loadRouteIntoEditor(defaultRouteForType(document.getElementById('mobile-detector_type').value));
}

function populateIsotopes(selected) {
    const sel = document.getElementById('mobile-isotope');
    const names = state.isotopes.map(i => i.name);
    if (selected && !names.includes(selected)) names.push(selected);
    sel.innerHTML = names.map(n => `<option value="${escAttr(n)}">${escHtml(n)}</option>`).join('');
    sel.value = selected || 'Cs-137';
}

function suggestMobilePort() {
    const type = document.getElementById('mobile-detector_type').value;
    const usedPorts = new Set([
        ...state.cameras.map(c => c.config.port),
        ...state.rpms.map(r => r.port),
        ...state.mobiles.map(m => m.port),
    ]);
    let suggested = type === 'd5' ? 10111 : 10110;
    while (usedPorts.has(suggested)) suggested++;
    document.getElementById('mobile-port').value = suggested;
    mobilePortAuto = true;
}

function openMobileModal(mobile = null) {
    editingMobileId = mobile ? mobile.id : null;

    const modal = document.getElementById('mobile-modal');
    const title = modal.querySelector('h2');
    const subtitle = modal.querySelector('.modal-subtitle');
    const submitBtn = modal.querySelector('[type="submit"]');

    if (mobile) {
        const cfg = mobile.config;
        title.textContent = 'Edit Mobile Detector';
        subtitle.textContent = 'Update settings. Changes take effect when the detector is started.';
        submitBtn.textContent = 'Save Changes';

        document.getElementById('mobile-name').value = cfg.name;
        document.getElementById('mobile-detector_type').value = cfg.detector_type;
        document.getElementById('mobile-port').value = cfg.port;
        mobilePortAuto = false;
        document.getElementById('mobile-serial').value = cfg.serial || '';
        document.getElementById('mobile-speed_mps').value = cfg.speed_mps;
        document.getElementById('mobile-alarm_interval_min').value = (cfg.alarm_interval_s || 0) / 60;
        populateIsotopes(cfg.isotope);
        document.getElementById('mobile-background_gamma_cps').value = cfg.background_gamma_cps;
        document.getElementById('mobile-background_neutron_cps').value = cfg.background_neutron_cps;
        document.getElementById('mobile-alarm_factor').value = cfg.alarm_factor;
        document.getElementById('mobile-alarm_duration_s').value = cfg.alarm_duration_s;
        routeDirty = true;  // editing an existing route — type switch must not clobber it
        routeLatLngs = (cfg.route || []).map(p => ({ lat: p[0], lng: p[1] }));
    } else {
        title.textContent = 'Add Mobile Detector';
        subtitle.textContent = 'Configure a walking RS-350 backpack or Kromek D5 RIID (TCP).';
        submitBtn.textContent = 'Start Mobile Detector';

        document.getElementById('mobile-form').reset();
        populateIsotopes('Cs-137');
        suggestMobilePort();
        routeDirty = false;
        routeLatLngs = defaultRouteForType('rs350').map(p => ({ lat: p[0], lng: p[1] }));
    }

    showModal('mobile-modal-overlay', 'mobile-modal');

    // Leaflet inside a display:none container needs a size recalc once the
    // modal is actually visible; run again after the 300ms open transition.
    if (ensureMobileMap()) {
        requestAnimationFrame(() => mobileMap.invalidateSize());
        setTimeout(() => {
            mobileMap.invalidateSize();
            rebuildRouteLayer();
            fitMobileMapToRoute();
        }, 350);
    } else {
        updateRouteStats();
    }
}

function closeMobileModal() {
    hideModal('mobile-modal-overlay', 'mobile-modal');
    editingMobileId = null;
}

document.getElementById('mobile-detector_type').addEventListener('change', () => {
    const type = document.getElementById('mobile-detector_type').value;
    if (editingMobileId) return;  // editing: never auto-rewrite fields
    if (mobilePortAuto) suggestMobilePort();
    // Swap in the type's default background unless the user changed it.
    const bgEl = document.getElementById('mobile-background_gamma_cps');
    if (bgEl.value === '1200' || bgEl.value === '900') {
        bgEl.value = type === 'd5' ? 900 : 1200;
    }
    if (!routeDirty) loadRouteIntoEditor(defaultRouteForType(type));
});

document.getElementById('mobile-port').addEventListener('input', () => { mobilePortAuto = false; });
document.getElementById('mobile-speed_mps').addEventListener('input', updateRouteStats);

// If a field inside the collapsed Advanced section fails native validation,
// the browser blocks submit but can't show the bubble on a hidden input —
// pop the section open so the failure is visible instead of silent.
document.getElementById('mobile-form').addEventListener('invalid', () => {
    document.querySelector('#mobile-modal details.advanced').open = true;
}, true);

document.getElementById('mobile-form').onsubmit = async (e) => {
    e.preventDefault();
    if (routeLatLngs.length < 2) {
        alert('The patrol route needs at least 2 waypoints — click the map to add them.');
        return;
    }

    const config = {
        name: document.getElementById('mobile-name').value,
        detector_type: document.getElementById('mobile-detector_type').value,
        port: parseInt(document.getElementById('mobile-port').value),
        serial: document.getElementById('mobile-serial').value.trim(),
        speed_mps: parseFloat(document.getElementById('mobile-speed_mps').value) || 1.4,
        route: routeLatLngs.map(ll => [ll.lat, ll.lng]),
        alarm_interval_s: (parseFloat(document.getElementById('mobile-alarm_interval_min').value) || 0) * 60,
        isotope: document.getElementById('mobile-isotope').value,
        background_gamma_cps: parseFloat(document.getElementById('mobile-background_gamma_cps').value) || 1200,
        background_neutron_cps: parseFloat(document.getElementById('mobile-background_neutron_cps').value) || 0,
        alarm_factor: parseFloat(document.getElementById('mobile-alarm_factor').value) || 1.6,
        alarm_duration_s: parseFloat(document.getElementById('mobile-alarm_duration_s').value) || 25,
    };

    const url = editingMobileId ? `/api/mobiles/${editingMobileId}` : '/api/mobiles';
    const method = editingMobileId ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        if (res.ok) {
            closeMobileModal();
            await fetchMobiles();
        } else {
            const err = await res.json();
            alert('Error: ' + formatApiError(err));
        }
    } catch (e) {
        alert('Failed to save mobile detector');
    }
};

async function startMobile(id) {
    try {
        const res = await fetch(`/api/mobiles/${id}/start`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + formatApiError(err));
        }
        await fetchMobiles();
    } catch (e) {
        alert('Failed to start mobile detector');
    }
}

async function stopMobile(id) {
    try {
        const res = await fetch(`/api/mobiles/${id}/stop`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + formatApiError(err));
        }
        await fetchMobiles();
    } catch (e) {
        alert('Failed to stop mobile detector');
    }
}

function editMobile(id) {
    const mobile = state.mobiles.find(m => m.id === id);
    if (mobile) openMobileModal(mobile);
}

async function deleteMobile(id) {
    if (!confirm('Stop and remove this mobile detector?')) return;
    try {
        await fetch(`/api/mobiles/${id}`, { method: 'DELETE' });
        delete state.mobileStatuses[id];
        await fetchMobiles();
    } catch (e) {
        alert('Failed to remove mobile detector');
    }
}

async function triggerMobileAlarm(id) {
    try {
        const res = await fetch(`/api/mobiles/${id}/trigger`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            alert('Error: ' + formatApiError(err));
        }
    } catch (e) {
        alert('Failed to trigger alarm episode');
    }
}

// FastAPI validation errors (422) arrive as a list of {loc, msg} objects —
// flatten to something readable instead of [object Object].
function formatApiError(err) {
    const d = err && err.detail;
    if (Array.isArray(d)) {
        return d.map(x => x.msg || JSON.stringify(x)).join('; ');
    }
    return d || 'Request failed';
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
document.getElementById('mobile-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeMobileModal();
});

// ── CSV export ───────────────────────────────────────────────────────────────

// Generates a site-config CSV in the format the external loader software
// expects. Columns and field order match the example provided by the user.
// Per-camera columns repeat as CameraType{i},CameraHost{i},CameraPath{i},
// Codec{i},Username{i},Password{i} — the row width is sized to the RPM with
// the most associated cameras; rows with fewer cameras pad with blanks.
// Mobile detectors are intentionally excluded: they are not Rapiscan lanes
// and the loader CSV format has no walker concept (OSCAR configures its
// RS-350/D5 driver lanes separately).
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

    await Promise.all([fetchCameras(), fetchRPMs(), fetchMobiles(), fetchFiles(),
                       fetchIsotopes(), fetchServerClock()]);
    await Promise.all([fetchRPMStatuses(), fetchMobileStatuses()]);

    setInterval(fetchCameras, 5000);
    // Refreshed so the schedule editor's "current hour" marker follows the
    // clock across hour boundaries and DST without a page reload.
    setInterval(fetchServerClock, 60000);
    setInterval(async () => {
        await fetchRPMs();
        await fetchRPMStatuses();
        await fetchMobiles();
        await fetchMobileStatuses();
    }, 3000);
}

init();
