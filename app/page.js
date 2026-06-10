'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

// ===== SUPABASE =====
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
let sb;

// ===== DATA =====
const MODULES = [
  { name: 'Módulo A', agents: ['Ana García','Carlos López','María Torres','Javier Ruiz','Laura Sánchez','Pedro Martín','Sofía Pérez','Diego Romero','Elena Vega','Roberto Gil','Carmen Díaz','Luis Moreno','Isabel Reyes','Alejandro Muñoz','Natalia Ortiz','Fernando Castro','Paula Jiménez','Sergio Navarro'] },
  { name: 'Módulo B', agents: ['Raúl Herrera','Marta Blanco','Antonio Ramos','Cristina Medina','Pablo Suárez','Andrea Molina','Francisco Cano','Beatriz León','Adrián Vargas','Patricia Iglesias','Óscar Fuentes','Silvia Guerrero'] },
  { name: 'Módulo C', agents: ['Miguel Ángel Rosa','Teresa Aguilar','Gonzalo Méndez','Verónica Prieto','Rubén Cabrera','Alicia Serrano','Enrique Delgado','Lucía Peña','Álvaro Domínguez','Noelia Ramírez'] }
];

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const DAYS_SHORT = ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];

let currentModule = 0;
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth();
let schedules = [{}, {}, {}];
let backupAgents = [{}, {}, {}];
let historialData = {};
let currentUser = null;
let jefeConfig = JSON.parse(typeof localStorage !== 'undefined' && localStorage.getItem('bjsJefeConfig') || 'null') || { nombre: '', email: '', telefono: '' };
let alertaCtx = { agente: null, day: null };
let editMode = false;
let pendingChanges = false;
let scheduleSnapshot = null;
let todayViewOpen = false;
let panelAgent = null;
let activePanelTab = 'estadisticas';
let agentesMod = 0;
let agentesInfo = [{}, {}, {}]; // { "Nombre": { email, tel } } por módulo
let recognition = null;
let voiceActive = false;

// In-memory admins store (Supabase profiles are the source of truth)
let DEMO_USERS = {};

// ===== HELPERS =====
function getDaysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
function getDayOfWeek(y, m, d) { return (new Date(y, m, d).getDay() + 6) % 7; }
function getKey(agent, day) { return `${agent}__${day}`; }
function isBackup(agent) { return !!backupAgents[currentModule][agent]; }

function pad(n) { return String(n).padStart(2, '0'); }
function formatDate(str) {
  if (!str) return '—';
  const [y, m, d] = str.split('-');
  return `${d}/${m}/${y}`;
}

// ===== DB FUNCTIONS =====
async function dbLoadAll() {
  showToast('⟳ Sincronizando con base de datos...', 'success');
  try {
    const { data: agentsData, error: aErr } = await sb.from('agents').select('*').order('id');
    if (aErr) throw aErr;
    if (agentsData && agentsData.length > 0) {
      MODULES.forEach(m => m.agents = []);
      backupAgents = [{}, {}, {}];
      agentesInfo = [{}, {}, {}];
      agentsData.forEach(a => {
        const idx = a.module_idx;
        if (!MODULES[idx].agents.includes(a.name)) MODULES[idx].agents.push(a.name);
        if (a.is_backup) backupAgents[idx][a.name] = true;
        if (a.email || a.tel) agentesInfo[idx][a.name] = { email: a.email || '', tel: a.tel || '' };
      });
    } else {
      await dbSeedAgents();
    }
    const { data: schedData, error: sErr } = await sb.from('schedules').select('*')
      .eq('year', currentYear).eq('month', currentMonth);
    if (sErr) throw sErr;
    schedules = [{}, {}, {}];
    if (schedData) schedData.forEach(s => {
      schedules[s.module_idx][getKey(s.agent_name, s.day)] = s.shift;
    });
    populateAgentSelects();
    renderGrid();
    showToast('✓ Datos cargados', 'success');
  } catch (e) {
    showToast('⚠ Error al cargar datos: ' + e.message, 'error');
  }
}

async function dbSeedAgents() {
  const rows = [];
  MODULES.forEach((m, idx) => m.agents.forEach(name => rows.push({ name, module_idx: idx, is_backup: false })));
  await sb.from('agents').insert(rows);
}

async function dbSaveShift(modIdx, agentName, day, shift) {
  await sb.from('schedules').upsert(
    { module_idx: modIdx, agent_name: agentName, year: currentYear, month: currentMonth, day, shift, updated_at: new Date().toISOString() },
    { onConflict: 'module_idx,agent_name,year,month,day' }
  );
}

async function dbSaveAllShifts(modIdx) {
  const s = schedules[modIdx];
  const rows = Object.entries(s).map(([key, shift]) => {
    const [agentName, dayStr] = key.split('__');
    return { module_idx: modIdx, agent_name: agentName, year: currentYear, month: currentMonth, day: parseInt(dayStr), shift, updated_at: new Date().toISOString() };
  });
  if (rows.length === 0) return;
  await sb.from('schedules').upsert(rows, { onConflict: 'module_idx,agent_name,year,month,day' });
}

async function dbSaveAgent(name, modIdx, email = '', tel = '') {
  await sb.from('agents').insert({ name, module_idx: modIdx, is_backup: false, email, tel });
}

async function dbDeleteAgent(name, modIdx) {
  await sb.from('agents').delete().eq('name', name).eq('module_idx', modIdx);
  await sb.from('schedules').delete().eq('agent_name', name).eq('module_idx', modIdx);
  await sb.from('historial').delete().eq('agent_name', name);
}

async function dbSetBackup(name, modIdx, isBackupVal) {
  await sb.from('agents').update({ is_backup: isBackupVal }).eq('name', name).eq('module_idx', modIdx);
}

async function dbLoadHistorial(agentName) {
  const { data } = await sb.from('historial').select('*').eq('agent_name', agentName).order('created_at', { ascending: false });
  if (!data) return;
  historialData[agentName] = { disciplina: [], ausencias: [] };
  data.forEach(r => {
    const entry = { tipo: r.tipo, fecha: r.fecha, nota: r.nota, _id: r.id };
    if (r.category === 'disc') historialData[agentName].disciplina.push(entry);
    else historialData[agentName].ausencias.push(entry);
  });
}

async function dbSaveHistorial(agentName, category, tipo, fecha, nota) {
  await sb.from('historial').insert({ agent_name: agentName, category, tipo, fecha, nota });
}

// ===== RENDER =====
function renderGrid() {
  const mod = MODULES[currentModule];
  const days = getDaysInMonth(currentYear, currentMonth);
  const head = document.getElementById('tableHead');
  const body = document.getElementById('tableBody');
  if (!head || !body) return;

  const todayDay = (currentYear === new Date().getFullYear() && currentMonth === new Date().getMonth())
    ? new Date().getDate() : -1;

  let headHTML = '<tr><th class="agent-col">Agente</th>';
  for (let d = 1; d <= days; d++) {
    const dow = getDayOfWeek(currentYear, currentMonth, d);
    const isWeekend = dow >= 5;
    const isToday = d === todayDay;
    headHTML += `<th data-day="${d}" class="${isWeekend ? 'weekend' : ''} ${isToday ? 'today-col' : ''}">
      ${isToday ? '● ' : ''}${d}<br><span style="font-weight:400;font-size:10px">${DAYS_SHORT[dow]}</span></th>`;
  }
  headHTML += '</tr>';
  head.innerHTML = headHTML;

  const s = schedules[currentModule];
  const isAgent = currentUser && currentUser.role === 'agent';
  const agentFilter = isAgent ? currentUser.name : null;
  let bodyHTML = '';
  mod.agents.forEach((agent, i) => {
    if (agentFilter && agent !== agentFilter) return;
    const backup = isBackup(agent);
    const backupDot = backup ? `<span class="backup-dot" title="Backup de emergencia"></span>` : '';
    const canEdit = !isAgent;
    bodyHTML += `<tr>
      <td class="agent-name" style="cursor:${canEdit ? 'pointer' : 'default'};">
        <span ${canEdit ? `onclick="openPanel('${agent.replace(/'/g, "\\'")}',${currentModule})" title="Ver historial"` : ''}>${agent}${backupDot}</span><br>
        <span class="role" style="display:flex;align-items:center;gap:5px;">
          ${canEdit ? `Agente ${i + 1}` : '<span style="color:var(--accent-light);font-size:11px;">Tu turno</span>'}
          ${canEdit && backup ? `<span style="font-size:10px;font-weight:600;color:#fb923c;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.3);padding:1px 6px;border-radius:8px;">backup</span>` : ''}
          ${canEdit ? `<span onclick="toggleBackup('${agent.replace(/'/g, "\\'")})"
            style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:600;
              cursor:pointer;padding:1px 6px;border-radius:10px;
              background:${backup ? 'rgba(251,146,60,0.15)' : 'rgba(107,128,153,0.12)'};
              color:${backup ? '#fb923c' : 'var(--muted)'};
              border:1px solid ${backup ? 'rgba(251,146,60,0.3)' : 'rgba(107,128,153,0.2)'};
              transition:all 0.15s;">
            ${backup ? '🟠 backup' : '＋ backup'}
          </span>` : ''}
        </span>
      </td>`;
    for (let d = 1; d <= days; d++) {
      const key = getKey(agent, d);
      const shift = s[key] || 'OFF';
      const label = shift === 'OFF' ? '—' : shift === 'BUS' ? '⟳' : shift;
      const isToday = d === todayDay;
      bodyHTML += `<td class="${isToday ? 'today-cell' : ''}"><span class="shift-cell ${shift}" onclick="toggleShift('${agent}',${d})"
        style="cursor:${editMode ? 'pointer' : 'default'};${editMode ? '' : 'opacity:0.9;'}"
        title="${editMode ? 'Click para cambiar' : 'Activa modo edición para modificar'}">${label}</span></td>`;
    }
    bodyHTML += '</tr>';
  });
  body.innerHTML = bodyHTML;
  updateStats();
  if (todayDay > 0) {
    setTimeout(() => {
      if (window.innerWidth > 768) {
        const todayTh = document.querySelector('thead th.today-col');
        if (todayTh) todayTh.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }, 80);
  }
  setTimeout(() => applyMobileWeekFilter(), 50);
}

// ===== EDIT MODE =====
function activarEdicion() {
  editMode = true;
  pendingChanges = false;
  scheduleSnapshot = JSON.parse(JSON.stringify(schedules));
  document.getElementById('btnEditar').style.display = 'none';
  document.getElementById('btnCancelar').style.display = '';
  document.getElementById('btnClone').style.display = '';
  document.getElementById('btnGenerar').style.display = '';
  document.getElementById('editBanner').style.display = 'flex';
  renderGrid();
}

function marcarPendiente() {
  if (!pendingChanges) {
    pendingChanges = true;
    document.getElementById('btnGuardar').style.display = '';
  }
}

async function guardarCambios() {
  const btn = document.getElementById('btnGuardar');
  btn.textContent = '⟳ Guardando...';
  btn.disabled = true;
  try {
    await dbSaveAllShifts(currentModule);
    salirEdicion();
    showToast('✓ Cambios guardados correctamente', 'success');
  } catch (e) {
    btn.textContent = '💾 Guardar cambios';
    btn.disabled = false;
    showToast('⚠ Error al guardar: ' + e.message, 'error');
  }
}

function cancelarEdicion() {
  if (pendingChanges && !confirm('¿Descartar los cambios sin guardar?')) return;
  if (scheduleSnapshot) schedules = JSON.parse(JSON.stringify(scheduleSnapshot));
  salirEdicion();
  renderGrid();
  if (pendingChanges) showToast('Cambios descartados', 'warning');
}

function salirEdicion() {
  editMode = false;
  pendingChanges = false;
  scheduleSnapshot = null;
  const btnEditar = document.getElementById('btnEditar');
  if (btnEditar) btnEditar.style.display = '';
  const btnCancelar = document.getElementById('btnCancelar');
  if (btnCancelar) btnCancelar.style.display = 'none';
  const btnGuardar = document.getElementById('btnGuardar');
  if (btnGuardar) btnGuardar.style.display = 'none';
  const btnClone = document.getElementById('btnClone');
  if (btnClone) btnClone.style.display = 'none';
  const btnGenerar = document.getElementById('btnGenerar');
  if (btnGenerar) btnGenerar.style.display = 'none';
  const banner = document.getElementById('editBanner');
  if (banner) banner.style.display = 'none';
  renderGrid();
}

function toggleShift(agent, day) {
  if (!editMode) return;
  const key = getKey(agent, day);
  const s = schedules[currentModule];
  const current = s[key] || 'OFF';
  const cycle = { 'A': 'B', 'B': 'OFF', 'OFF': 'A', 'AUS': 'A', 'BUS': 'A' };
  s[key] = cycle[current];
  marcarPendiente();
  renderGrid();
}

// ===== GENERATE =====
function generateRandom() {
  const mod = MODULES[currentModule];
  const days = getDaysInMonth(currentYear, currentMonth);
  const s = {};
  mod.agents.forEach(agent => {
    for (let d = 1; d <= days; d++) {
      const dow = getDayOfWeek(currentYear, currentMonth, d);
      if (dow >= 5) { s[getKey(agent, d)] = 'OFF'; continue; }
      s[getKey(agent, d)] = Math.random() > 0.5 ? 'A' : 'B';
    }
  });
  schedules[currentModule] = s;
  if (!editMode) activarEdicion();
  marcarPendiente();
  renderGrid();
  showToast('Cronograma generado — pulsa Guardar para confirmar ⚡', 'success');
  updateStats();
}

function cloneLastMonth() {
  const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
  const mod = MODULES[currentModule];
  const days = getDaysInMonth(currentYear, currentMonth);
  const s = {};
  mod.agents.forEach(agent => {
    for (let d = 1; d <= days; d++) {
      const dow = getDayOfWeek(currentYear, currentMonth, d);
      if (dow >= 5) { s[getKey(agent, d)] = 'OFF'; continue; }
      s[getKey(agent, d)] = schedules[currentModule][getKey(agent, d)] || (Math.random() > 0.5 ? 'A' : 'B');
    }
  });
  schedules[currentModule] = s;
  if (!editMode) activarEdicion();
  marcarPendiente();
  renderGrid();
  showToast(`Replicado desde ${MONTHS[prevMonth]} — pulsa Guardar para confirmar`, 'success');
  updateStats();
}

// ===== STATS =====
function updateStats() {
  const mod = MODULES[currentModule];
  const now = new Date();
  const today = (currentYear === now.getFullYear() && currentMonth === now.getMonth()) ? now.getDate() : 1;
  const s = schedules[currentModule];
  let countA = 0, countB = 0, countAus = 0;
  mod.agents.forEach(agent => {
    const shift = s[getKey(agent, today)] || 'OFF';
    if (shift === 'A') countA++;
    if (shift === 'B') countB++;
    if (shift === 'AUS') countAus++;
  });
  const sa = document.getElementById('statActivos');
  const sA = document.getElementById('statA');
  const sB = document.getElementById('statB');
  const sAus = document.getElementById('statAus');
  if (sa) sa.textContent = mod.agents.length;
  if (sA) sA.textContent = countA || '—';
  if (sB) sB.textContent = countB || '—';
  if (sAus) sAus.textContent = countAus;
  if (countA + countB > 0 && countA + countB < 5) {
    document.getElementById('alertBanner')?.classList.add('show');
  }
}

// ===== MONTH NAV =====
async function changeMonth(dir) {
  currentMonth += dir;
  if (currentMonth > 11) { currentMonth = 0; currentYear++; }
  if (currentMonth < 0) { currentMonth = 11; currentYear--; }
  document.getElementById('monthLabel').textContent = `${MONTHS[currentMonth]} ${currentYear}`;
  const { data } = await sb.from('schedules').select('*').eq('year', currentYear).eq('month', currentMonth);
  schedules = [{}, {}, {}];
  if (data) data.forEach(s => { schedules[s.module_idx][getKey(s.agent_name, s.day)] = s.shift; });
  renderGrid();
}

// ===== TABS =====
function switchModule(idx, el) {
  currentModule = idx;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  populateAgentSelects();
  renderGrid();
}

// ===== MODALS =====
function openModal(id) {
  document.getElementById(id)?.classList.add('open');
  if (id === 'modal-alerta') actualizarPreview();
  if (id === 'modal-backups') renderBackupModal();
  if (id === 'modal-agentes') { agentesMod = currentModule; renderAgentesModal(); }
  if (id === 'modal-jefes') renderJefesModal();
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
}

function renderBackupModal() {
  const agents = MODULES[currentModule].agents;
  const list = document.getElementById('backup-agent-list');
  if (!list) return;
  list.innerHTML = agents.map(agent => {
    const active = isBackup(agent);
    return `<div onclick="toggleBackup('${agent.replace(/'/g, "\\'")}');renderBackupModal();"
      style="display:flex;align-items:center;justify-content:space-between;
        padding:12px 14px;border-radius:10px;cursor:pointer;
        background:${active ? 'rgba(251,146,60,0.1)' : 'var(--bg)'};
        border:1px solid ${active ? 'rgba(251,146,60,0.4)' : 'var(--border)'};
        transition:all 0.15s;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:32px;height:32px;border-radius:50%;
          background:${active ? 'rgba(251,146,60,0.2)' : 'var(--surface)'};
          border:1px solid ${active ? '#fb923c' : 'var(--border)'};
          display:flex;align-items:center;justify-content:center;
          font-size:12px;font-weight:700;color:${active ? '#fb923c' : 'var(--muted)'};">
          ${agent.split(' ').map(w => w[0]).join('').slice(0, 2)}
        </div>
        <div>
          <div style="font-size:13px;font-weight:600;color:${active ? 'var(--text)' : 'var(--muted)'};">${agent}</div>
          <div style="font-size:11px;color:var(--muted);">${MODULES[currentModule].name}</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${active ? '<span style="font-size:11px;font-weight:600;color:#fb923c;">BACKUP</span>' : ''}
        <div style="width:36px;height:20px;border-radius:10px;background:${active ? '#fb923c' : 'var(--border)'};position:relative;transition:background 0.2s;">
          <div style="width:16px;height:16px;border-radius:50%;background:white;position:absolute;top:2px;transition:left 0.2s;left:${active ? '18px' : '2px'};"></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function populateAgentSelects() {
  const agents = MODULES[currentModule].agents;
  ['aus-agente', 'cambio-agente', 'alerta-agente'].forEach(id => {
    const sel = document.getElementById(id);
    if (sel) sel.innerHTML = agents.map(a => `<option>${a}</option>`).join('');
  });
  const today = new Date();
  const el = document.getElementById('aus-fecha');
  if (el) el.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
}

// ===== TOASTS =====
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3500);
}

// ===== AUTH =====
const QUICK_CREDS = {
  admin: { email: 'admin@bjs.com', pass: 'Admin1234!' },
  agent: { email: 'ana@bjs.com', pass: 'Agente1234!' },
  agent2: { email: 'carlos@bjs.com', pass: 'Agente1234!' },
};

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.remove('show');

  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { errEl.textContent = 'Email o contraseña incorrectos'; errEl.classList.add('show'); return; }

  const { data: profile, error: pErr } = await sb.from('profiles').select('*').eq('id', data.user.id).single();
  if (pErr || !profile) {
    errEl.textContent = 'Perfil no encontrado. Contacta al administrador.';
    errEl.classList.add('show');
    await sb.auth.signOut(); return;
  }
  applyLogin({ email, role: profile.role, name: profile.name, module: profile.module_idx, tel: profile.tel });
}

function quickLogin(type) {
  const c = QUICK_CREDS[type];
  document.getElementById('loginEmail').value = c.email;
  document.getElementById('loginPass').value = c.pass;
  doLogin();
}

function applyLogin(user) {
  currentUser = user;
  document.getElementById('loginScreen').classList.add('hidden');
  const initials = user.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('userAvatar').textContent = initials;
  document.getElementById('userLabel').textContent = user.name;
  const isAdmin = user.role === 'admin';

  if (isAdmin) {
    document.getElementById('userAvatar').style.background = 'rgba(72,180,224,0.2)';
    document.getElementById('userAvatar').style.color = 'var(--accent-light)';
    document.getElementById('adminActions').style.display = 'flex';
    document.getElementById('agentActions').style.display = 'none';
    document.getElementById('agentBanner').classList.remove('show');
    document.querySelectorAll('.tab').forEach(t => t.style.pointerEvents = '');
    document.getElementById('btnToday').style.display = '';
  } else {
    document.getElementById('userAvatar').style.background = 'rgba(128,255,218,0.15)';
    document.getElementById('userAvatar').style.color = 'var(--green-text)';
    document.getElementById('adminActions').style.display = 'none';
    document.getElementById('agentActions').style.display = 'flex';
    document.getElementById('agentBannerName').textContent = user.name;
    document.getElementById('agentBanner').classList.add('show');
    document.querySelectorAll('.tab').forEach((t, i) => {
      t.style.pointerEvents = i === user.module ? '' : 'none';
      t.style.opacity = i === user.module ? '1' : '0.3';
    });
    currentModule = user.module;
    document.querySelectorAll('.tab')[user.module].classList.add('active');
    document.getElementById('btnToday').style.display = 'none';
    document.getElementById('btnEditar').style.display = 'none';
  }

  populateAgentSelects();
  showToast(`Bienvenido/a, ${user.name.split(' ')[0]} 👋`, 'success');
  dbLoadAll();
}

async function doLogout() {
  await sb.auth.signOut();
  currentUser = null;
  editMode = false; pendingChanges = false;
  schedules = [{}, {}, {}];
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginEmail').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').classList.remove('show');
  document.getElementById('agentBanner').classList.remove('show');
  salirEdicion();
}

// ===== ACTIONS =====
function reportarAusencia() {
  const agente = document.getElementById('aus-agente').value;
  const fecha = document.getElementById('aus-fecha').value;
  const antelacion = document.getElementById('aus-antelacion').value;
  const day = parseInt(fecha.split('-')[2]);
  schedules[currentModule][getKey(agente, day)] = 'AUS';
  renderGrid();
  closeModal('modal-ausencia');
  if (antelacion === '0') {
    showToast(`⚠ Alerta URGENTE enviada al jefe por ausencia de ${agente.split(' ')[0]}`, 'warning');
    setTimeout(() => showToast('📧 Email enviado · 📱 WhatsApp enviado', 'success'), 800);
  } else {
    showToast(`✓ Ausencia de ${agente.split(' ')[0]} registrada — Jefe notificado`, 'success');
    setTimeout(() => showToast('📧 Email enviado al jefe de equipo', 'success'), 600);
  }
}

function solicitarCambio() {
  const agente = document.getElementById('cambio-agente').value;
  closeModal('modal-cambio');
  showToast(`⇄ Solicitud de cambio enviada para ${agente.split(' ')[0]}`, 'success');
  setTimeout(() => showToast('📧 El jefe de equipo recibirá la solicitud para aprobación', 'success'), 700);
}

function guardarConfig() {
  jefeConfig.nombre = document.getElementById('cfg-nombre').value.trim();
  jefeConfig.email = document.getElementById('cfg-email').value.trim();
  jefeConfig.telefono = document.getElementById('cfg-telefono').value.trim();
  if (!jefeConfig.nombre || (!jefeConfig.email && !jefeConfig.telefono)) {
    showToast('Completa al menos nombre + email o teléfono', 'error'); return;
  }
  if (typeof localStorage !== 'undefined') localStorage.setItem('bjsJefeConfig', JSON.stringify(jefeConfig));
  closeModal('modal-config');
  showToast(`✓ Jefe guardado: ${jefeConfig.nombre}`, 'success');
  actualizarPreview();
}

function actualizarPreview() {
  const tipo = document.getElementById('alerta-tipo')?.value || '';
  const agente = document.getElementById('alerta-agente')?.value || '';
  const canal = document.getElementById('alerta-canal')?.value || '';
  const ahora = new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const destEl = document.getElementById('dest-info');
  if (destEl) {
    if (jefeConfig.nombre) {
      destEl.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px;">
        <span style="color:var(--text);font-weight:600">${jefeConfig.nombre}</span>
        ${jefeConfig.email ? `<span style="color:var(--muted)">📧 ${jefeConfig.email}</span>` : ''}
        ${jefeConfig.telefono ? `<span style="color:var(--muted)">📱 ${jefeConfig.telefono}</span>` : ''}
        <span style="color:var(--accent-light);cursor:pointer;font-size:12px;" onclick="closeModal('modal-alerta');openModal('modal-config')">✏ Editar contacto</span>
      </div>`;
    } else {
      destEl.innerHTML = `Sin configurar — <span style="color:var(--accent-light);cursor:pointer;" onclick="closeModal('modal-alerta');openModal('modal-config')">añadir jefe de equipo →</span>`;
    }
  }

  const previewEl = document.getElementById('preview-msg');
  if (!previewEl) return;
  const nombre = jefeConfig.nombre || '[Jefe de equipo]';
  let msg = '';
  if (canal.includes('Email') || canal === 'Email + WhatsApp') {
    msg = `ASUNTO: 🔔 Alerta TurnoSync — ${tipo}\n\nHola ${nombre},\n\nSe ha generado una alerta en el sistema de turnos:\n\n  📋 Tipo:   ${tipo}\n  👤 Agente: ${agente}\n  🕐 Hora:   ${ahora}\n  📍 Módulo: ${MODULES[currentModule].name}\n\nPor favor, toma acción en los próximos minutos.\n\n— TurnoSync`;
  } else {
    msg = `[WhatsApp / SMS]\n\n🔔 *TurnoSync Alert*\n${tipo}\nAgente: ${agente}\nHora: ${ahora}\nMódulo: ${MODULES[currentModule].name}\n\nResponde para confirmar acción.`;
  }
  previewEl.textContent = msg;
}

function enviarAlerta() {
  const tipo = document.getElementById('alerta-tipo').value;
  const agente = document.getElementById('alerta-agente').value;
  const canal = document.getElementById('alerta-canal').value;
  const escalado = document.getElementById('alerta-escalado').value;

  alertaCtx.agente = agente;
  alertaCtx.day = new Date().getDate();

  const ahora = new Date().toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const msgCorto = `🔔 TurnoSync · ${tipo}\nAgente: ${agente}\nMódulo: ${MODULES[currentModule].name}\nHora: ${ahora}\n\nPor favor confirma acción o el sistema escalará en ${escalado} min.`;
  const msgEmail = `ASUNTO: 🔔 Alerta TurnoSync — ${tipo}\n\nHola ${jefeConfig.nombre || 'Jefe/a'},\n\nAlerta:\n\n  📋 Tipo: ${tipo}\n  👤 Agente: ${agente}\n  🕐 Hora: ${ahora}\n  📍 Módulo: ${MODULES[currentModule].name}\n\n— BJS TurnoSync`;

  closeModal('modal-alerta');
  showToast(`🔔 Enviando alerta: "${tipo}"`, 'error');

  let delay = 300;

  // WhatsApp
  if (jefeConfig.telefono && (canal.includes('WhatsApp') || canal === 'Email + WhatsApp')) {
    const tel = jefeConfig.telefono.replace(/\s|\+/g, '');
    const waUrl = `https://wa.me/${tel}?text=${encodeURIComponent(msgCorto)}`;
    setTimeout(() => { window.open(waUrl, '_blank'); showToast(`📱 WhatsApp abierto para ${jefeConfig.nombre || jefeConfig.telefono}`, 'success'); }, delay);
    delay += 600;
  }

  // Email real via Resend
  if (jefeConfig.email && canal.includes('Email')) {
    const htmlBody = `
      <div style="font-family:Inter,sans-serif;background:#0a0f1e;color:#f0f4ff;padding:32px;border-radius:12px;max-width:520px;">
        <div style="font-size:22px;font-weight:800;margin-bottom:4px;"><span style="color:#48b4e0;">BJS</span> TurnoSync</div>
        <div style="font-size:13px;color:#6b8099;margin-bottom:24px;">Sistema de gestión de turnos</div>
        <div style="background:#111827;border:1px solid #1e2d45;border-radius:10px;padding:20px;margin-bottom:16px;">
          <div style="font-size:11px;font-weight:700;color:#6b8099;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:14px;">🔔 Alerta de turno</div>
          <div style="margin-bottom:10px;"><span style="color:#6b8099;font-size:12px;">Tipo</span><br><strong style="font-size:14px;">${tipo}</strong></div>
          <div style="margin-bottom:10px;"><span style="color:#6b8099;font-size:12px;">Agente afectado</span><br><strong style="font-size:14px;">${agente}</strong></div>
          <div style="margin-bottom:10px;"><span style="color:#6b8099;font-size:12px;">Módulo</span><br><strong style="font-size:14px;">${MODULES[currentModule].name}</strong></div>
          <div><span style="color:#6b8099;font-size:12px;">Hora</span><br><strong style="font-size:14px;">${ahora}</strong></div>
        </div>
        <div style="background:#7c4a00;border:1px solid #92400e;border-radius:8px;padding:12px;font-size:13px;color:#fde68a;">
          ⏱ Si no respondes en ${escalado} min el sistema contactará a agentes backup.
        </div>
        <div style="margin-top:20px;font-size:11px;color:#6b8099;">BJS TurnoSync · BJS Legal Services España</div>
      </div>`;

    setTimeout(async () => {
      try {
        const res = await fetch('/api/send-alert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: jefeConfig.email,
            subject: `🔔 Alerta TurnoSync — ${tipo}`,
            html: htmlBody,
          }),
        });
        const result = await res.json();
        if (result.success) showToast(`📧 Email enviado a ${jefeConfig.email}`, 'success');
        else showToast(`⚠ Error al enviar email: ${result.error}`, 'error');
      } catch (e) {
        showToast('⚠ Error de conexión al enviar email', 'error');
      }
    }, delay);
    delay += 600;
  }

  if (!jefeConfig.email && !jefeConfig.telefono)
    showToast('⚠ Sin contacto configurado — ve a ⚙ Configurar alertas', 'warning');

  setTimeout(() => {
    document.getElementById('accion-sub').textContent = `Alerta sobre ${agente.split(' ')[0]} enviada. ¿Cómo gestionas la cobertura?`;
    const backups = getBackupAgents();
    document.getElementById('backup-list-preview').innerHTML = backups.length
      ? backups.map(b => `<span style="background:var(--red);color:var(--red-text);padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600;">${b.split(' ')[0]}</span>`).join('')
      : `<span style="font-size:12px;color:var(--muted);">Sin agentes backup asignados aún</span>`;
    openModal('modal-accion');
  }, delay);
}

function getBackupAgents() {
  const marked = Object.keys(backupAgents[currentModule]);
  if (marked.length) return marked;
  const s = schedules[currentModule];
  const hoy = new Date().getDate();
  return MODULES[currentModule].agents.filter(a => (s[getKey(a, hoy)] || 'OFF') === 'OFF').slice(0, 4);
}

function activarProtocolo() {
  closeModal('modal-accion');
  const backups = getBackupAgents();
  if (backups.length === 0) { showToast('⚠ No hay agentes libres hoy para contactar', 'warning'); return; }
  showToast(`📣 Protocolo activado — contactando ${backups.length} agentes backup`, 'error');
  backups.forEach((b, i) => {
    setTimeout(() => showToast(`📱 Mensaje enviado a ${b.split(' ')[0]}`, 'success'), 600 + i * 400);
  });
  setTimeout(() => showToast('⏱ Si nadie confirma en 15 min → siguiente nivel de escalado', 'warning'), 600 + backups.length * 400);
}

function gestionManual() {
  closeModal('modal-accion');
  const { agente, day } = alertaCtx;
  if (!agente || !day) return;
  schedules[currentModule][getKey(agente, day)] = 'BUS';
  renderGrid();
  showToast(`⟳ "${agente.split(' ')[0]}" marcado como "En búsqueda de reemplazo"`, 'warning');
  setTimeout(() => showToast('🔒 Estado visible solo para jefes de equipo', 'success'), 700);
}

function hideBanner() { document.getElementById('alertBanner')?.classList.remove('show'); }

// ===== TODAY VIEW =====
function toggleTodayView() {
  todayViewOpen = !todayViewOpen;
  document.getElementById('todayView')?.classList.toggle('open', todayViewOpen);
  const btn = document.getElementById('btnToday');
  if (btn) btn.textContent = todayViewOpen ? '✕ Cerrar vista hoy' : '📅 Vista de hoy';
  if (todayViewOpen) renderTodayView();
}

function renderTodayView() {
  const now = new Date();
  const today = (currentYear === now.getFullYear() && currentMonth === now.getMonth()) ? now.getDate() : 1;
  const s = schedules[currentModule];
  const mod = MODULES[currentModule];
  const dias = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const lbl = document.getElementById('todayDateLabel');
  if (lbl) lbl.textContent = `${dias[now.getDay()]} ${today} de ${MONTHS[currentMonth]} ${currentYear}`;

  const ausentes = mod.agents.filter(a => (s[getKey(a, today)] || 'OFF') === 'AUS');
  const enBusqueda = mod.agents.filter(a => (s[getKey(a, today)] || 'OFF') === 'BUS');
  const absentEl = document.getElementById('todayAbsent');
  let absentHTML = '';
  if (ausentes.length || enBusqueda.length) {
    absentHTML = `<div class="today-absent"><div class="today-absent-title">⚠ Incidencias hoy — ${ausentes.length + enBusqueda.length} agente(s)</div>`;
    ausentes.forEach(a => absentHTML += `<div class="today-agent-row"><span class="today-agent-name">${a} ${isBackup(a) ? '<span class="backup-dot"></span>' : ''}</span><span class="badge badge-red">Ausente</span></div>`);
    enBusqueda.forEach(a => absentHTML += `<div class="today-agent-row"><span class="today-agent-name">${a}</span><span class="badge badge-yellow">En búsqueda</span></div>`);
    absentHTML += '</div>';
  } else {
    absentHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:13px;color:var(--green-text);">✓ Sin ausencias ni incidencias hoy</div>`;
  }
  if (absentEl) absentEl.innerHTML = absentHTML;

  const turnoA = mod.agents.filter(a => (s[getKey(a, today)] || 'OFF') === 'A');
  const turnoB = mod.agents.filter(a => (s[getKey(a, today)] || 'OFF') === 'B');
  const renderList = agents => agents.length
    ? agents.map(a => `<div class="today-agent-row"><span class="today-agent-name">${a}${isBackup(a) ? '<span class="backup-dot"></span>' : ''}</span><span style="font-size:11px;color:var(--muted);">${isBackup(a) ? 'backup' : '·'}</span></div>`).join('')
    : `<div style="color:var(--muted);font-size:13px;padding:8px 0;">Sin agentes asignados</div>`;

  const grid = document.getElementById('todayGrid');
  if (grid) grid.innerHTML = `
    <div class="today-shift-block">
      <div class="today-shift-title"><span style="background:var(--shift-a);color:var(--shift-a-text);padding:2px 8px;border-radius:5px;font-size:11px;">A</span>Turno mañana · 9–17h<span style="margin-left:auto;color:var(--shift-a-text);font-size:16px;font-weight:700;">${turnoA.length}</span></div>
      ${renderList(turnoA)}
    </div>
    <div class="today-shift-block">
      <div class="today-shift-title"><span style="background:var(--shift-b);color:var(--shift-b-text);padding:2px 8px;border-radius:5px;font-size:11px;">B</span>Turno tarde · 11–20h<span style="margin-left:auto;color:var(--shift-b-text);font-size:16px;font-weight:700;">${turnoB.length}</span></div>
      ${renderList(turnoB)}
    </div>`;
}

// ===== BACKUP TOGGLE =====
function toggleBackup(agent) {
  if (backupAgents[currentModule][agent]) delete backupAgents[currentModule][agent];
  else backupAgents[currentModule][agent] = true;
  const isBk = !!backupAgents[currentModule][agent];
  renderGrid();
  showToast(isBk ? `${agent.split(' ')[0]} marcado como backup 🟠` : `${agent.split(' ')[0]} quitado de backup`, 'success');
  dbSetBackup(agent, currentModule, isBk);
}

// ===== PANEL =====
function getAgentHist(agent) {
  if (!historialData[agent]) historialData[agent] = { disciplina: [], ausencias: [] };
  return historialData[agent];
}

function openPanel(agent, moduleIdx) {
  panelAgent = agent;
  document.getElementById('panelAgentName').textContent = agent;
  const info = agentesInfo[moduleIdx]?.[agent] || {};
  const meta = [MODULES[moduleIdx].name + ' · Agente', info.email, info.tel].filter(Boolean).join(' · ');
  document.getElementById('panelAgentMeta').textContent = meta;
  document.getElementById('sidePanel').classList.add('open');
  document.getElementById('panelBackdrop').classList.add('open');
  dbLoadHistorial(agent).then(() => renderPanelTab('estadisticas'));
  document.querySelectorAll('.panel-tab').forEach((t, i) => t.classList.toggle('active', i === 0));
  activePanelTab = 'estadisticas';
  document.querySelectorAll('[id^="tab-"]').forEach(el => el.style.display = 'none');
  document.getElementById('tab-estadisticas').style.display = 'block';
}

function closePanel() {
  document.getElementById('sidePanel')?.classList.remove('open');
  document.getElementById('panelBackdrop')?.classList.remove('open');
}


function switchPanelTab(tab, el) {
  activePanelTab = tab;
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('[id^="tab-"]').forEach(e => e.style.display = 'none');
  document.getElementById(`tab-${tab}`).style.display = 'block';
  renderPanelTab(tab);
}

function renderPanelTab(tab) {
  if (!panelAgent) return;
  if (tab === 'estadisticas') renderEstadisticas();
  if (tab === 'disciplina') renderDisciplina();
  if (tab === 'ausencias') renderAusenciasHist();
}

function renderEstadisticas() {
  const s = schedules[currentModule];
  const days = getDaysInMonth(currentYear, currentMonth);
  let cA = 0, cB = 0, cOff = 0, cAus = 0;
  for (let d = 1; d <= days; d++) {
    const v = s[getKey(panelAgent, d)] || 'OFF';
    if (v === 'A') cA++; else if (v === 'B') cB++; else if (v === 'AUS') cAus++; else cOff++;
  }
  const hist = getAgentHist(panelAgent);
  const totalDisc = hist.disciplina.length;

  document.getElementById('panelStats').innerHTML = `
    <div class="mini-card"><div class="val" style="color:var(--shift-a-text)">${cA}</div><div class="lbl">Turno A</div></div>
    <div class="mini-card"><div class="val" style="color:var(--shift-b-text)">${cB}</div><div class="lbl">Turno B</div></div>
    <div class="mini-card"><div class="val" style="color:var(--red-text)">${cAus}</div><div class="lbl">Ausencias mes</div></div>
    <div class="mini-card"><div class="val" style="color:var(--yellow-text)">${totalDisc}</div><div class="lbl">Incidencias</div></div>
    <div class="mini-card"><div class="val" style="color:var(--muted)">${cOff}</div><div class="lbl">Días libres</div></div>
    <div class="mini-card"><div class="val" style="color:var(--green-text)">${cA + cB}</div><div class="lbl">Días trabajados</div></div>
  `;

  let barHTML = '';
  for (let d = 1; d <= days; d++) {
    const v = s[getKey(panelAgent, d)] || 'OFF';
    barHTML += `<div class="shift-dot ${v}" title="Día ${d}: ${v}"></div>`;
  }
  document.getElementById('panelShiftBar').innerHTML = barHTML;

  const todas = [
    ...hist.disciplina.map(x => ({ ...x, cat: 'disc' })),
    ...hist.ausencias.map(x => ({ ...x, cat: 'aus' }))
  ].sort((a, b) => new Date(b.fecha) - new Date(a.fecha)).slice(0, 4);

  const cont = document.getElementById('panelUltimasIncidencias');
  cont.innerHTML = todas.length === 0
    ? `<div style="color:var(--muted);font-size:13px;">Sin incidencias registradas.</div>`
    : todas.map(x => incidenciaHTML(x)).join('');
}

function incidenciaHTML(x) {
  if (x.cat === 'disc') {
    const tipos = { amonestacion: '🔴', amonestacion_escrita: '🔴', apercibimiento: '🟡', suspension: '⛔' };
    const labels = { amonestacion: 'Amonestación verbal', amonestacion_escrita: 'Amonestación escrita', apercibimiento: 'Apercibimiento formal', suspension: 'Suspensión de empleo' };
    const iconClass = x.tipo === 'apercibimiento' ? 'icon-apercib' : 'icon-amone';
    return `<div class="historial-item"><div class="item-icon ${iconClass}">${tipos[x.tipo] || '⚠'}</div><div class="item-body"><div class="item-title">${labels[x.tipo] || x.tipo}</div><div class="item-date">${formatDate(x.fecha)}</div>${x.nota ? `<div class="item-note">${x.nota}</div>` : ''}</div></div>`;
  } else {
    const iconos = { 'Falta injustificada': '🚫', 'Enfermedad justificada': '🤒', 'Enfermedad no justificada': '😷', 'Vacaciones': '🌴', 'Asunto personal': '👤' };
    return `<div class="historial-item"><div class="item-icon icon-aus">${iconos[x.tipo] || '📅'}</div><div class="item-body"><div class="item-title">${x.tipo}</div><div class="item-date">${formatDate(x.fecha)}</div>${x.nota ? `<div class="item-note">${x.nota}</div>` : ''}</div></div>`;
  }
}

function renderDisciplina() {
  const hist = getAgentHist(panelAgent);
  const cont = document.getElementById('listaDisciplina');
  cont.innerHTML = hist.disciplina.length === 0
    ? `<div style="color:var(--muted);font-size:13px;">Sin registros disciplinarios.</div>`
    : hist.disciplina.slice().reverse().map(x => incidenciaHTML({ ...x, cat: 'disc' })).join('');
}

function renderAusenciasHist() {
  const hist = getAgentHist(panelAgent);
  const cont = document.getElementById('listaAusencias');
  cont.innerHTML = hist.ausencias.length === 0
    ? `<div style="color:var(--muted);font-size:13px;">Sin ausencias registradas.</div>`
    : hist.ausencias.slice().reverse().map(x => incidenciaHTML({ ...x, cat: 'aus' })).join('');
}

function agregarDisciplina() {
  const tipo = document.getElementById('disc-tipo').value;
  const fecha = document.getElementById('disc-fecha').value;
  const nota = document.getElementById('disc-nota').value.trim();
  if (!fecha) { showToast('Selecciona una fecha', 'error'); return; }
  getAgentHist(panelAgent).disciplina.push({ tipo, fecha, nota });
  toggleAddForm('form-disciplina');
  document.getElementById('disc-nota').value = '';
  renderDisciplina();
  showToast('Registro disciplinario añadido', 'warning');
  dbSaveHistorial(panelAgent, 'disc', tipo, fecha, nota);
}

function agregarAusenciaHist() {
  const fecha = document.getElementById('ah-fecha').value;
  const tipo = document.getElementById('ah-tipo').value;
  const nota = document.getElementById('ah-nota').value.trim();
  if (!fecha) { showToast('Selecciona una fecha', 'error'); return; }
  getAgentHist(panelAgent).ausencias.push({ tipo, fecha, nota });
  toggleAddForm('form-ausencia-hist');
  document.getElementById('ah-nota').value = '';
  renderAusenciasHist();
  showToast('Ausencia registrada', 'success');
  dbSaveHistorial(panelAgent, 'aus', tipo, fecha, nota);
}

function toggleAddForm(id) {
  const f = document.getElementById(id);
  f.classList.toggle('open');
  if (f.classList.contains('open')) {
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    f.querySelectorAll('input[type="date"]').forEach(el => el.value = dateStr);
  }
}

// ===== GESTIÓN AGENTES =====
function switchAgentesTab(idx, el) {
  agentesMod = idx;
  document.querySelectorAll('#agentes-mod-tabs button').forEach((b, i) => {
    b.className = i === idx ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  });
  renderAgentesModal();
}

function renderAgentesModal() {
  const agents = MODULES[agentesMod].agents;
  const el = document.getElementById('agentes-list');
  if (!el) return;
  if (agents.length === 0) {
    el.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px;">Sin agentes en este módulo.</div>`;
    return;
  }
  el.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="color:var(--muted);text-align:left;border-bottom:1px solid var(--border);">
          <th style="padding:6px 8px;font-weight:600;">Agente</th>
          <th style="padding:6px 8px;font-weight:600;">Email acceso</th>
          <th style="padding:6px 8px;font-weight:600;">Teléfono</th>
          <th style="padding:6px 8px;font-weight:600;width:60px;"></th>
        </tr>
      </thead>
      <tbody>
        ${agents.map((agent, i) => {
          const info = agentesInfo[agentesMod]?.[agent] || {};
          const initials = agent.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
          return `
          <tr style="border-bottom:1px solid rgba(30,45,69,0.5);">
            <td style="padding:10px 8px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <div style="width:28px;height:28px;border-radius:50%;background:var(--surface);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--muted);flex-shrink:0;">${initials}</div>
                <span style="font-weight:500;color:var(--text);">${agent}</span>
              </div>
            </td>
            <td style="padding:10px 8px;">
              ${info.email
                ? `<div style="display:flex;align-items:center;gap:6px;">
                    <span style="color:#48b4e0;">${info.email}</span>
                    <button onclick="navigator.clipboard.writeText('${info.email}');window.showToast('Email copiado','success')" title="Copiar" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;padding:2px;">📋</button>
                   </div>`
                : `<span style="color:var(--muted);font-style:italic;">Sin email</span>`}
            </td>
            <td style="padding:10px 8px;">
              ${info.tel
                ? `<div style="display:flex;align-items:center;gap:6px;">
                    <span style="color:var(--text);">${info.tel}</span>
                    <button onclick="navigator.clipboard.writeText('${info.tel}');window.showToast('Teléfono copiado','success')" title="Copiar" style="background:none;border:none;cursor:pointer;color:var(--muted);font-size:12px;padding:2px;">📋</button>
                   </div>`
                : `<span style="color:var(--muted);font-style:italic;">Sin teléfono</span>`}
            </td>
            <td style="padding:10px 8px;text-align:right;">
              <button onclick="removeAgente(${i})" title="Eliminar agente" style="width:26px;height:26px;border-radius:6px;background:rgba(127,29,29,0.3);border:1px solid rgba(127,29,29,0.5);color:#fca5a5;cursor:pointer;font-size:13px;">×</button>
            </td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

function addAgente() {
  const name = document.getElementById('new-agent-name').value.trim();
  const email = document.getElementById('new-agent-email').value.trim();
  const tel = document.getElementById('new-agent-tel').value.trim();
  const modIdx = parseInt(document.getElementById('new-agent-module').value);
  if (!name) { showToast('Escribe el nombre del agente', 'error'); return; }
  if (MODULES[modIdx].agents.includes(name)) { showToast('Ya existe un agente con ese nombre', 'error'); return; }
  MODULES[modIdx].agents.push(name);
  if (email || tel) agentesInfo[modIdx][name] = { email, tel };
  dbSaveAgent(name, modIdx, email, tel);
  ['new-agent-name','new-agent-email','new-agent-tel'].forEach(id => document.getElementById(id).value = '');
  agentesMod = modIdx;
  document.querySelectorAll('#agentes-mod-tabs button').forEach((b, i) => {
    b.className = i === modIdx ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  });
  renderAgentesModal();
  populateAgentSelects();
  if (currentModule === modIdx) renderGrid();
  showToast(`✓ ${name.split(' ')[0]} añadido al ${MODULES[modIdx].name}`, 'success');
}

function removeAgente(idx) {
  const agent = MODULES[agentesMod].agents[idx];
  if (!confirm(`¿Eliminar a "${agent}" del cronograma? Esta acción no se puede deshacer.`)) return;
  MODULES[agentesMod].agents.splice(idx, 1);
  delete backupAgents[agentesMod][agent];
  delete historialData[agent];
  Object.keys(schedules[agentesMod]).forEach(k => { if (k.startsWith(agent + '__')) delete schedules[agentesMod][k]; });
  dbDeleteAgent(agent, agentesMod);
  renderAgentesModal();
  populateAgentSelects();
  if (currentModule === agentesMod) renderGrid();
  showToast(`${agent.split(' ')[0]} eliminado del cronograma`, 'warning');
}

// ===== GESTIÓN JEFES =====
function renderJefesModal() {
  const admins = Object.entries(DEMO_USERS).filter(([, u]) => u.role === 'admin');
  const el = document.getElementById('jefes-list');
  if (!el) return;
  el.innerHTML = admins.length === 0
    ? `<div style="color:var(--muted);font-size:13px;padding:8px;">Los jefes se gestionan desde Supabase Auth.</div>`
    : admins.map(([email, u]) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:10px;background:var(--bg);border:1px solid ${email === currentUser?.email ? 'rgba(72,180,224,0.4)' : 'var(--border)'};">
      <div style="display:flex;align-items:center;gap:10px;">
        <div style="width:34px;height:34px;border-radius:50%;background:rgba(72,180,224,0.15);border:1px solid rgba(72,180,224,0.3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--accent-light);">${u.name.split(' ').map(w => w[0]).join('').slice(0, 2)}</div>
        <div>
          <div style="display:flex;align-items:center;gap:6px;"><span style="font-size:13px;font-weight:600;">${u.name}</span>${email === currentUser?.email ? '<span style="font-size:10px;background:rgba(72,180,224,0.15);color:var(--accent-light);padding:1px 6px;border-radius:8px;font-weight:600;">tú</span>' : ''}</div>
          <div style="font-size:11px;color:var(--muted);">📧 ${email}${u.tel ? ' · 📱 ' + u.tel : ''}</div>
        </div>
      </div>
      ${email !== currentUser?.email ? `<button onclick="removeJefe('${email}')" style="width:28px;height:28px;border-radius:7px;background:rgba(127,29,29,0.3);border:1px solid rgba(127,29,29,0.5);color:#fca5a5;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;">×</button>` : `<span style="font-size:11px;color:var(--muted);padding-right:4px;">sesión activa</span>`}
    </div>`).join('');
}

function addJefe() {
  const name = document.getElementById('new-jefe-name').value.trim();
  const email = document.getElementById('new-jefe-email').value.trim().toLowerCase();
  const pass = document.getElementById('new-jefe-pass').value;
  const tel = document.getElementById('new-jefe-tel').value.trim();
  if (!name || !email || !pass) { showToast('Nombre, email y contraseña son obligatorios', 'error'); return; }
  if (pass.length < 6) { showToast('La contraseña debe tener al menos 6 caracteres', 'error'); return; }
  if (DEMO_USERS[email]) { showToast('Ya existe un usuario con ese email', 'error'); return; }
  DEMO_USERS[email] = { pass, role: 'admin', name, module: null, tel };
  ['new-jefe-name', 'new-jefe-email', 'new-jefe-pass', 'new-jefe-tel'].forEach(id => document.getElementById(id).value = '');
  renderJefesModal();
  showToast(`✓ Jefe "${name}" añadido — necesita cuenta en Supabase Auth`, 'success');
}

function removeJefe(email) {
  if (email === currentUser?.email) { showToast('No puedes eliminarte a ti mismo', 'error'); return; }
  const u = DEMO_USERS[email];
  if (!confirm(`¿Eliminar al jefe "${u.name}"?`)) return;
  delete DEMO_USERS[email];
  renderJefesModal();
  showToast(`${u.name.split(' ')[0]} eliminado de jefes`, 'warning');
}

// ===== GDPR — DERECHO AL OLVIDO (Art. 17) =====
async function eliminarDatosAgente() {
  if (!panelAgent) return;
  if (!confirm(`⚠ GDPR Art. 17 — Derecho al olvido\n\n¿Eliminar TODOS los datos de "${panelAgent}"?\n\nEsto borrará:\n• Historial de ausencias\n• Registros disciplinarios\n• Turnos en el cronograma\n\nEsta acción NO se puede deshacer.`)) return;
  try {
    await dbDeleteAgent(panelAgent, currentModule);
    delete historialData[panelAgent];
    const idx = MODULES[currentModule].agents.indexOf(panelAgent);
    if (idx > -1) MODULES[currentModule].agents.splice(idx, 1);
    delete backupAgents[currentModule][panelAgent];
    Object.keys(schedules[currentModule]).forEach(k => { if (k.startsWith(panelAgent + '__')) delete schedules[currentModule][k]; });
    closePanel();
    populateAgentSelects();
    renderGrid();
    showToast(`✓ Datos de ${panelAgent.split(' ')[0]} eliminados (GDPR Art.17)`, 'success');
    panelAgent = null;
  } catch (e) {
    showToast('Error al eliminar datos: ' + e.message, 'error');
  }
}

// ===== VOZ =====
function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Usa Chrome para comandos de voz', 'error'); return null; }
  const r = new SR();
  r.lang = 'es-ES';
  r.continuous = false;
  r.interimResults = false;
  r.maxAlternatives = 3;
  r.onresult = e => {
    const t = Array.from(e.results[0]).map(a => a.transcript).join(' ').toLowerCase().trim();
    setVoiceOverlay(`"${t}"`, 'heard');
    processVoiceCommand(t);
    setTimeout(() => { stopVoice(); hideVoiceOverlay(); }, 1800);
  };
  r.onerror = e => { stopVoice(); hideVoiceOverlay(); if (e.error !== 'no-speech') showToast('Error de micrófono: ' + e.error, 'error'); };
  r.onend = () => { if (voiceActive) stopVoice(); };
  return r;
}

function toggleVoice() { voiceActive ? stopVoice() : startVoice(); }

function startVoice() {
  if (!recognition) recognition = initRecognition();
  if (!recognition) return;
  voiceActive = true;
  const btn = document.getElementById('btnVoz');
  if (btn) { btn.className = 'btn btn-ghost btn-sm btn-voz-active'; btn.innerHTML = '<span class="voice-dot"></span> Escuchando…'; }
  setVoiceOverlay('Escuchando…', 'listening');
  try { recognition.start(); } catch (e) { recognition = initRecognition(); recognition?.start(); }
}

function stopVoice() {
  voiceActive = false;
  const btn = document.getElementById('btnVoz');
  if (btn) { btn.className = 'btn btn-ghost btn-sm'; btn.textContent = '🎤 Voz'; }
  try { recognition?.stop(); } catch (e) {}
}

function setVoiceOverlay(text, mode) {
  let el = document.getElementById('voiceOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'voiceOverlay';
    el.style.cssText = `position:fixed;bottom:84px;left:50%;transform:translateX(-50%);background:#111827;border:1px solid #1e2d45;border-radius:14px;padding:14px 22px;font-size:13px;color:#f0f4ff;z-index:400;text-align:center;min-width:280px;box-shadow:0 8px 32px rgba(0,0,0,0.6);`;
    document.body.appendChild(el);
  }
  el.style.display = 'block';
  if (mode === 'listening') {
    el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;gap:10px;"><span class="voice-dot"></span><span style="color:#a5b4fc;font-weight:500;">Di tu comando…</span></div><div style="font-size:11px;color:#6b8099;margin-top:6px;">"Ana turno A del 1 al 10" · "Carlos libre los lunes" · "guardar"</div>`;
  } else {
    el.innerHTML = `<div style="font-size:11px;color:#6b8099;margin-bottom:4px;">Detectado</div><div style="font-weight:500;">${text}</div>`;
  }
}

function hideVoiceOverlay() {
  const el = document.getElementById('voiceOverlay');
  if (el) el.style.display = 'none';
}

const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Nombres de días de semana → índice (0=lun … 6=dom)
const DOW_MAP = { lunes:1, martes:2, miercoles:3, jueves:4, viernes:5, sabado:6, domingo:0 };

function findAgent(t) {
  const agents = MODULES[currentModule].agents;
  let best = null, bestScore = 0;
  agents.forEach(a => {
    let score = 0;
    norm(a).split(' ').forEach(w => { if (w.length > 2 && norm(t).includes(w)) score += 2; });
    // también primer nombre suelto
    const first = norm(a.split(' ')[0]);
    if (first.length > 2 && norm(t).includes(first)) score++;
    if (score > bestScore) { bestScore = score; best = a; }
  });
  return bestScore > 0 ? best : null;
}

function findAllAgents(t) {
  const agents = MODULES[currentModule].agents;
  return agents.filter(a => {
    return norm(a).split(' ').some(w => w.length > 2 && norm(t).includes(w));
  });
}

// Devuelve array de números de día según el texto
function resolveDays(t) {
  const total = getDaysInMonth(currentYear, currentMonth);
  const days = [];

  // "toda la semana" / "todo el mes" / "todos los días"
  if (/toda la semana|todos los dias|todo el mes/.test(t)) {
    for (let d = 1; d <= total; d++) days.push(d);
    return [...new Set(days)];
  }

  // "del X al Y" / "desde el X hasta el Y"
  const rangeM = t.match(/(?:del|desde el?)\s+(\d{1,2})\s+(?:al|hasta el?)\s+(\d{1,2})/);
  if (rangeM) {
    const from = parseInt(rangeM[1]), to = parseInt(rangeM[2]);
    for (let d = Math.min(from,to); d <= Math.min(Math.max(from,to), total); d++) days.push(d);
  }

  // "los lunes" / "los martes y jueves" / "de lunes a viernes"
  const rangeDow = t.match(/de\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\s+a\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)/);
  if (rangeDow) {
    const start = DOW_MAP[rangeDow[1]], end = DOW_MAP[rangeDow[2]];
    for (let d = 1; d <= total; d++) {
      const dow = getDayOfWeek(currentYear, currentMonth, d); // 0=lun
      if (dow >= start - 1 && dow <= end - 1) days.push(d);
    }
  }

  // días de semana nombrados: "el lunes", "los martes", "lunes y miércoles"
  Object.entries(DOW_MAP).forEach(([name, dowVal]) => {
    if (new RegExp(`\\b${name}\\b`).test(t)) {
      for (let d = 1; d <= total; d++) {
        // getDayOfWeek devuelve 0=lun…6=dom
        if (getDayOfWeek(currentYear, currentMonth, d) === dowVal - 1) days.push(d);
      }
    }
  });

  // días numéricos sueltos: "el 3", "día 15", "días 5 y 12"
  const numMatches = t.matchAll(/\b(\d{1,2})\b/g);
  for (const m of numMatches) {
    const d = parseInt(m[1]);
    if (d >= 1 && d <= total) days.push(d);
  }

  return [...new Set(days)].sort((a,b) => a-b);
}

function detectShift(t) {
  if (/turno\s*a\b|turno mañana|mañana(?!na)|turno de mañana/.test(t)) return 'A';
  if (/turno\s*b\b|turno tarde|tarde|turno de tarde/.test(t)) return 'B';
  if (/\blibre\b|descanso|\boff\b|dia libre/.test(t)) return 'OFF';
  if (/ausente|ausencia/.test(t)) return 'AUS';
  if (/busqueda|en busqueda/.test(t)) return 'BUS';
  return null;
}

function applyShiftToGrid(agent, days, shift) {
  if (!editMode) activarEdicion();
  days.forEach(d => { schedules[currentModule][getKey(agent, d)] = shift; });
  marcarPendiente();
  renderGrid();
}

function processVoiceCommand(raw) {
  const t = norm(raw);

  // ── Comandos de sistema ──
  if (/editar|modo edicion/.test(t)) { activarEdicion(); showToast('🎤 Modo edición activado', 'success'); return; }
  if (/guardar/.test(t)) { guardarCambios(); return; }
  if (/cancelar/.test(t)) { cancelarEdicion(); return; }
  if (/generar|aleatorio/.test(t)) { generateRandom(); return; }
  if (/replicar|copiar mes/.test(t)) { cloneLastMonth(); return; }
  if (/vista.*hoy/.test(t)) { toggleTodayView(); return; }

  const modMap = [[/modulo\s*a|banca/, 0], [/modulo\s*b|seguros/, 1], [/modulo\s*c|telco/, 2]];
  for (const [re, idx] of modMap) {
    if (re.test(t)) {
      const tabs = document.querySelectorAll('.tab');
      switchModule(idx, tabs[idx]);
      tabs.forEach((tb, i) => tb.classList.toggle('active', i === idx));
      showToast(`🎤 ${MODULES[idx].name}`, 'success');
      return;
    }
  }

  if (/backup/.test(t)) {
    const agent = findAgent(t);
    if (!agent) { showToast('🎤 No reconocí el agente', 'warning'); return; }
    const quitar = /quitar|eliminar|borrar/.test(t);
    if (quitar) delete backupAgents[currentModule][agent];
    else backupAgents[currentModule][agent] = true;
    dbSetBackup(agent, currentModule, !!backupAgents[currentModule][agent]);
    renderGrid();
    showToast(`🎤 ${agent.split(' ')[0]} ${quitar ? 'quitado de' : 'marcado como'} backup`, 'success');
    return;
  }

  if (/añadir|agregar|nuevo agente/.test(t)) { openModal('modal-agentes'); showToast('🎤 Panel de agentes', 'success'); return; }

  // ── Dictado de turnos (natural) ──
  // Intenta procesar frases compuestas separadas por "y", "," o punto
  // Ej: "Ana turno A del 1 al 5, Carlos libre los lunes"
  const clauses = raw.split(/[,;]|\by\b(?=\s+[A-Z])/i).map(c => c.trim()).filter(Boolean);
  let totalApplied = 0;

  clauses.forEach(clause => {
    const tc = norm(clause);
    const shift = detectShift(tc);
    if (!shift) return;
    const agent = findAgent(tc);
    if (!agent) return;
    const days = resolveDays(tc);
    if (days.length === 0) {
      // sin días explícitos → día de hoy
      const today = new Date().getDate();
      const total = getDaysInMonth(currentYear, currentMonth);
      if (today >= 1 && today <= total) days.push(today);
    }
    applyShiftToGrid(agent, days, shift);
    const labels = { A:'Turno A', B:'Turno B', OFF:'Libre', AUS:'Ausencia', BUS:'En búsqueda' };
    showToast(`🎤 ${agent.split(' ')[0]} · ${days.length === 1 ? `día ${days[0]}` : `${days.length} días`} → ${labels[shift]}`, 'success');
    totalApplied++;
  });

  if (totalApplied > 0) return;

  if (/ayuda|comandos/.test(t)) {
    showToast('🎤 Ejemplos: "Ana turno A del 1 al 10" · "Carlos libre los lunes" · "María ausente día 15" · "guardar"', 'success');
    return;
  }

  showToast(`🎤 No entendí: "${raw.substring(0,40)}" — Di "ayuda" para ejemplos`, 'warning');
}

// ===== MOBILE WEEK VIEW =====
let mobileWeekOffset = 0; // 0 = semana actual

function getMobileWeekRange() {
  const today = new Date(currentYear, currentMonth, new Date().getDate());
  const dow = today.getDay(); // 0=dom
  const mondayOffset = (dow === 0 ? -6 : 1 - dow);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() + mondayOffset + mobileWeekOffset * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  return { start: weekStart.getDate(), end: weekEnd.getDate(), startMonth: weekStart.getMonth(), endMonth: weekEnd.getMonth() };
}

function applyMobileWeekFilter() {
  if (typeof window === 'undefined' || window.innerWidth > 768) return;
  const { start, end, startMonth, endMonth } = getMobileWeekRange();
  const total = getDaysInMonth(currentYear, currentMonth);
  const table = document.getElementById('scheduleTable');
  if (!table) return;

  // Update week label
  const label = document.getElementById('mobile-week-label');
  if (label) {
    const fmt = d => `${d} ${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][currentMonth]}`;
    const s = startMonth === currentMonth ? start : 1;
    const e = endMonth === currentMonth ? end : total;
    label.textContent = `${fmt(s)} — ${fmt(e)}`;
  }

  // Show/hide columns
  const ths = table.querySelectorAll('thead th');
  const rows = table.querySelectorAll('tbody tr');
  ths.forEach((th, i) => {
    if (i === 0) return; // agent name col
    const day = parseInt(th.dataset.day);
    const visible = !isNaN(day) && day >= (startMonth === currentMonth ? start : 1) && day <= (endMonth === currentMonth ? end : total);
    th.classList.toggle('col-hidden-mobile', !visible);
    rows.forEach(row => {
      const td = row.cells[i];
      if (td) td.classList.toggle('col-hidden-mobile', !visible);
    });
  });
}

function mobileWeekPrev() { mobileWeekOffset--; applyMobileWeekFilter(); }
function mobileWeekNext() { mobileWeekOffset++; applyMobileWeekFilter(); }

// ===== AYUDA / CONTACTO =====
function switchAyudaTab(tab) {
  document.getElementById('ayuda-tab-faq').style.display = tab === 'faq' ? '' : 'none';
  document.getElementById('ayuda-tab-contacto').style.display = tab === 'contacto' ? '' : 'none';
  document.getElementById('faq-actions').style.display = tab === 'faq' ? '' : 'none';
  document.getElementById('tab-faq').className = tab === 'faq' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  document.getElementById('tab-contacto').className = tab === 'contacto' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  document.getElementById('tab-faq').style.flex = '1';
  document.getElementById('tab-contacto').style.flex = '1';
  document.getElementById('tab-faq').style.fontSize = '13px';
  document.getElementById('tab-contacto').style.fontSize = '13px';
}

async function enviarContacto() {
  const nombre = document.getElementById('contacto-nombre').value.trim();
  const email = document.getElementById('contacto-email').value.trim();
  const mensaje = document.getElementById('contacto-mensaje').value.trim();
  const statusEl = document.getElementById('contacto-status');
  if (!nombre || !email || !mensaje) { statusEl.style.color = '#fca5a5'; statusEl.textContent = 'Completa todos los campos.'; return; }
  statusEl.style.color = '#6b8099'; statusEl.textContent = 'Enviando…';
  try {
    const html = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0f1e;color:#f0f4ff;border-radius:10px;max-width:500px;">
      <div style="font-size:18px;font-weight:800;margin-bottom:16px;"><span style="color:#48b4e0;">BJS</span> TurnoSync — Consulta de usuario</div>
      <p><strong>Nombre:</strong> ${nombre}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Mensaje:</strong></p>
      <p style="background:#111827;padding:12px;border-radius:8px;color:#a5b4fc;">${mensaje.replace(/\n/g,'<br>')}</p>
    </div>`;
    const res = await fetch('/api/send-alert', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ to: 'giulichiatti@gmail.com', subject: `💬 Consulta TurnoSync — ${nombre}`, html }) });
    const r = await res.json();
    if (r.success) { statusEl.style.color = '#86efac'; statusEl.textContent = '✓ Mensaje enviado. Te responderemos pronto.'; document.getElementById('contacto-mensaje').value = ''; }
    else { statusEl.style.color = '#fca5a5'; statusEl.textContent = `Error: ${r.error}`; }
  } catch(e) { statusEl.style.color = '#fca5a5'; statusEl.textContent = `Error: ${e.message}`; }
}

// ===== ERROR MONITORING =====
const CRITICAL_ERRORS_SENT = new Set();

async function sendCriticalError(msg, source) {
  const key = msg.substring(0, 80);
  if (CRITICAL_ERRORS_SENT.has(key)) return; // no spam
  CRITICAL_ERRORS_SENT.add(key);
  try {
    const html = `<div style="font-family:Inter,sans-serif;padding:24px;background:#0a0f1e;color:#f0f4ff;border-radius:10px;max-width:500px;">
      <div style="font-size:18px;font-weight:800;color:#fca5a5;margin-bottom:16px;">🚨 Error crítico — BJS TurnoSync</div>
      <p><strong>Origen:</strong> ${source}</p>
      <p><strong>Error:</strong></p>
      <p style="background:#7f1d1d;padding:12px;border-radius:8px;font-family:monospace;font-size:12px;">${msg}</p>
      <p style="color:#6b8099;font-size:11px;">Hora: ${new Date().toLocaleString('es-ES')}</p>
    </div>`;
    await fetch('/api/send-alert', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ to: 'giulichiatti@gmail.com', subject: `🚨 Error crítico TurnoSync — ${source}`, html }) });
  } catch(_) {}
}

function isCriticalError(msg) {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return m.includes('supabase') || m.includes('fetch') || m.includes('auth') ||
    m.includes('database') || m.includes('network') || m.includes('unauthorized') ||
    m.includes('500') || m.includes('failed to load') || m.includes('cannot read') ||
    m.includes('undefined is not') || m.includes('null is not');
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    if (window.innerWidth <= 768) applyMobileWeekFilter();
    else {
      // restaurar todas las columnas en desktop
      document.querySelectorAll('.col-hidden-mobile').forEach(el => el.classList.remove('col-hidden-mobile'));
    }
  });
  window.addEventListener('error', e => {
    if (isCriticalError(e.message)) sendCriticalError(e.message + '\n' + (e.filename || ''), 'window.onerror');
  });
  window.addEventListener('unhandledrejection', e => {
    const msg = e.reason?.message || String(e.reason);
    if (isCriticalError(msg)) sendCriticalError(msg, 'unhandledrejection');
  });
}

// ===== EXPOSE GLOBALLY (needed for inline onclick handlers) =====
if (typeof window !== 'undefined') {
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.doLogin = doLogin;
  window.quickLogin = quickLogin;
  window.doLogout = doLogout;
  window.switchModule = switchModule;
  window.changeMonth = changeMonth;
  window.toggleShift = toggleShift;
  window.toggleBackup = toggleBackup;
  window.activarEdicion = activarEdicion;
  window.guardarCambios = guardarCambios;
  window.cancelarEdicion = cancelarEdicion;
  window.toggleTodayView = toggleTodayView;
  window.hideBanner = hideBanner;
  window.reportarAusencia = reportarAusencia;
  window.solicitarCambio = solicitarCambio;
  window.guardarConfig = guardarConfig;
  window.actualizarPreview = actualizarPreview;
  window.enviarAlerta = enviarAlerta;
  window.activarProtocolo = activarProtocolo;
  window.gestionManual = gestionManual;
  window.openPanel = openPanel;
  window.closePanel = closePanel;
  window.switchPanelTab = switchPanelTab;
  window.toggleAddForm = toggleAddForm;
  window.agregarDisciplina = agregarDisciplina;
  window.agregarAusenciaHist = agregarAusenciaHist;
  window.eliminarDatosAgente = eliminarDatosAgente;
  window.toggleVoice = toggleVoice;
  window.renderBackupModal = renderBackupModal;
  window.switchAgentesTab = switchAgentesTab;
  window.addAgente = addAgente;
  window.removeAgente = removeAgente;
  window.addJefe = addJefe;
  window.removeJefe = removeJefe;
  window.cloneLastMonth = cloneLastMonth;
  window.generateRandom = generateRandom;
  window.openImportModal = openImportModal;
  window.importCSV = importCSV;
  window.downloadPlantilla = downloadPlantilla;
  window.confirmImport = confirmImport;
  window.mobileWeekPrev = mobileWeekPrev;
  window.mobileWeekNext = mobileWeekNext;
  window.applyMobileWeekFilter = applyMobileWeekFilter;
  window.switchAyudaTab = switchAyudaTab;
  window.enviarContacto = enviarContacto;
  window.switchImportTab = switchImportTab;
  window.previewFoto = previewFoto;
  window.analizarFoto = analizarFoto;
  window.confirmFoto = confirmFoto;
}

// ===== CSV IMPORT =====
function openImportModal() {
  document.getElementById('csv-input').value = '';
  document.getElementById('csv-preview').innerHTML = '';
  document.getElementById('csv-error').textContent = '';
  document.getElementById('btn-import-confirm').style.display = 'none';
  openModal('modal-import');
}

function downloadPlantilla() {
  const agents = MODULES[currentModule].agents;
  const days = getDaysInMonth(currentYear, currentMonth);
  const rows = ['agente,dia,turno'];
  agents.forEach(a => {
    for (let d = 1; d <= days; d++) {
      const dow = getDayOfWeek(currentYear, currentMonth, d);
      rows.push(`${a},${d},${dow >= 5 ? 'OFF' : 'A'}`);
    }
  });
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `plantilla_turnos_${MODULES[currentModule].name.replace(/\s/g,'_')}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function importCSV() {
  const file = document.getElementById('csv-file-input').files[0];
  const text = document.getElementById('csv-input').value.trim();
  const errEl = document.getElementById('csv-error');
  const previewEl = document.getElementById('csv-preview');
  const confirmBtn = document.getElementById('btn-import-confirm');
  errEl.textContent = '';
  previewEl.innerHTML = '';
  confirmBtn.style.display = 'none';

  const raw = file ? null : text;
  if (file) {
    const reader = new FileReader();
    reader.onload = e => parseAndPreviewCSV(e.target.result);
    reader.readAsText(file);
    return;
  }
  if (!raw) { errEl.textContent = 'Pega el CSV o sube un archivo.'; return; }
  parseAndPreviewCSV(raw);
}

let csvParsed = null;

function parseAndPreviewCSV(raw) {
  const errEl = document.getElementById('csv-error');
  const previewEl = document.getElementById('csv-preview');
  const confirmBtn = document.getElementById('btn-import-confirm');
  const agents = MODULES[currentModule].agents.map(a => a.toLowerCase());
  const validShifts = ['A', 'B', 'OFF', 'AUS', 'BUS'];
  const days = getDaysInMonth(currentYear, currentMonth);

  const lines = raw.trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) { errEl.textContent = 'El archivo está vacío o no tiene datos.'; return; }

  // Detect separator
  const sep = lines[0].includes(';') ? ';' : ',';
  const header = lines[0].split(sep).map(h => h.trim().toLowerCase());
  const iAgente = header.findIndex(h => h.includes('agent') || h.includes('nombre'));
  const iDia = header.findIndex(h => h.includes('dia') || h.includes('día') || h.includes('day'));
  const iTurno = header.findIndex(h => h.includes('turno') || h.includes('shift'));

  if (iAgente < 0 || iDia < 0 || iTurno < 0) {
    errEl.textContent = 'Columnas no reconocidas. Usa: agente, dia, turno';
    return;
  }

  const result = {};
  const errors = [];
  let ok = 0;

  lines.slice(1).forEach((line, i) => {
    const cols = line.split(sep).map(c => c.trim());
    const agente = cols[iAgente] || '';
    const dia = parseInt(cols[iDia]);
    const turno = (cols[iTurno] || '').toUpperCase();

    const matchedAgent = MODULES[currentModule].agents.find(a =>
      norm(a).includes(norm(agente)) || norm(agente).includes(norm(a.split(' ')[0]))
    );

    if (!matchedAgent) { errors.push(`Fila ${i+2}: agente no encontrado — "${agente}"`); return; }
    if (!dia || dia < 1 || dia > days) { errors.push(`Fila ${i+2}: día inválido — ${cols[iDia]}`); return; }
    if (!validShifts.includes(turno)) { errors.push(`Fila ${i+2}: turno inválido — "${turno}" (usa A, B, OFF, AUS, BUS)`); return; }

    result[getKey(matchedAgent, dia)] = turno;
    ok++;
  });

  if (ok === 0) { errEl.textContent = 'No se pudo leer ninguna fila válida.'; return; }

  csvParsed = result;

  // Preview
  const errCount = errors.length;
  previewEl.innerHTML = `
    <div style="color:#86efac;font-size:13px;margin-bottom:8px;">✓ ${ok} turnos listos para importar${errCount ? ` · <span style="color:#fca5a5">${errCount} errores ignorados</span>` : ''}</div>
    ${errors.slice(0,3).map(e => `<div style="color:#fca5a5;font-size:11px;">${e}</div>`).join('')}
    ${errCount > 3 ? `<div style="color:#6b8099;font-size:11px;">…y ${errCount-3} más</div>` : ''}
  `;
  confirmBtn.style.display = 'inline-flex';
}

function confirmImport() {
  if (!csvParsed) return;
  if (!editMode) activarEdicion();
  Object.assign(schedules[currentModule], csvParsed);
  csvParsed = null;
  marcarPendiente();
  renderGrid();
  updateStats();
  closeModal('modal-import');
  showToast('📥 Horario importado — pulsa Guardar para confirmar', 'success');
}

function switchImportTab(tab) {
  document.getElementById('import-tab-csv').style.display = tab === 'csv' ? '' : 'none';
  document.getElementById('import-tab-foto').style.display = tab === 'foto' ? '' : 'none';
  document.getElementById('tab-csv').className = tab === 'csv' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  document.getElementById('tab-foto').className = tab === 'foto' ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm';
  document.getElementById('tab-csv').style.flex = '1';
  document.getElementById('tab-foto').style.flex = '1';
  document.getElementById('tab-csv').style.fontSize = '13px';
  document.getElementById('tab-foto').style.fontSize = '13px';
}

function previewFoto() {
  const file = document.getElementById('foto-file-input').files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = document.getElementById('foto-preview-img');
  img.src = url;
  document.getElementById('foto-preview-wrap').style.display = 'block';
  document.getElementById('btn-foto-analizar').style.display = 'inline-flex';
  document.getElementById('foto-result').innerHTML = '';
  document.getElementById('foto-error').textContent = '';
  document.getElementById('btn-foto-confirm').style.display = 'none';
}

let fotoParsed = null;

async function analizarFoto() {
  const file = document.getElementById('foto-file-input').files[0];
  const errEl = document.getElementById('foto-error');
  const resultEl = document.getElementById('foto-result');
  const confirmBtn = document.getElementById('btn-foto-confirm');
  const analizarBtn = document.getElementById('btn-foto-analizar');

  if (!file) { errEl.textContent = 'Selecciona una imagen primero.'; return; }

  errEl.textContent = '';
  resultEl.innerHTML = '<div style="color:#6b8099;font-size:13px;">🔍 Analizando imagen con IA…</div>';
  analizarBtn.disabled = true;
  analizarBtn.textContent = 'Analizando…';

  try {
    const base64 = await fileToBase64(file);
    const agents = MODULES[currentModule].agents;

    const res = await fetch('/api/interpret-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64, mimeType: file.type, agents, month: currentMonth, year: currentYear })
    });

    const data = await res.json();

    if (data.error) { errEl.textContent = `Error: ${data.error}`; resultEl.innerHTML = ''; return; }

    const turnos = data.turnos || [];
    if (turnos.length === 0) { errEl.textContent = 'No se detectaron turnos en la imagen.'; resultEl.innerHTML = ''; return; }

    // Mapear a schedules format
    fotoParsed = {};
    const validShifts = ['A','B','OFF','AUS','BUS'];
    let ok = 0;
    turnos.forEach(({ agente, dia, turno }) => {
      const matchedAgent = agents.find(a =>
        norm(a).includes(norm(agente)) || norm(agente).includes(norm(a.split(' ')[0]))
      );
      if (!matchedAgent || !dia || !validShifts.includes(turno)) return;
      fotoParsed[getKey(matchedAgent, dia)] = turno;
      ok++;
    });

    resultEl.innerHTML = `<div style="color:#86efac;font-size:13px;">✓ ${ok} turnos detectados en la imagen</div>`;
    confirmBtn.style.display = 'inline-flex';

  } catch (e) {
    errEl.textContent = `Error: ${e.message}`;
    resultEl.innerHTML = '';
  } finally {
    analizarBtn.disabled = false;
    analizarBtn.textContent = '🔍 Analizar con IA';
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function confirmFoto() {
  if (!fotoParsed) return;
  if (!editMode) activarEdicion();
  Object.assign(schedules[currentModule], fotoParsed);
  fotoParsed = null;
  marcarPendiente();
  renderGrid();
  updateStats();
  closeModal('modal-import');
  showToast('📷 Horario importado desde foto — pulsa Guardar para confirmar', 'success');
}

// ===== REACT COMPONENT =====
export default function Home() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Init Supabase
    sb = createClient(SUPA_URL, SUPA_KEY);

    // Wire up overlay click-outside-to-close
    document.querySelectorAll('.overlay').forEach(el => {
      el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); });
    });

    // Set month label
    const ml = document.getElementById('monthLabel');
    if (ml) ml.textContent = `${MONTHS[currentMonth]} ${currentYear}`;

    // Safari iOS: touchend fix for panel close button
    setTimeout(() => {
      const closeBtn = document.querySelector('.panel-close');
      if (closeBtn) {
        closeBtn.addEventListener('touchend', e => { e.preventDefault(); e.stopPropagation(); closePanel(); }, { passive: false });
      }
    }, 500);

    setMounted(true);
  }, []);

  return (
    <>
      {/* LOGIN SCREEN */}
      <div className="login-screen" id="loginScreen">
        <div className="login-box">
          <div className="login-logo"><span>BJS</span> TurnoSync</div>
          <div className="login-sub">Gestión de turnos y cronogramas</div>
          <div className="login-error" id="loginError">Email o contraseña incorrectos</div>
          <div className="form-group">
            <label className="form-label">Email</label>
            <input type="email" className="form-control" id="loginEmail" placeholder="tu@bjslegal.com"
              onKeyDown={e => { if (e.key === 'Enter') window.doLogin?.(); }} />
          </div>
          <div className="form-group">
            <label className="form-label">Contraseña</label>
            <input type="password" className="form-control" id="loginPass" placeholder="••••••••"
              onKeyDown={e => { if (e.key === 'Enter') window.doLogin?.(); }} />
          </div>
          <button className="btn btn-primary" style={{ width: '100%', marginTop: 8, padding: '11px' }}
            onClick={() => window.doLogin?.()}>Entrar</button>
          <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 12 }}>Acceso rápido (demo)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start', gap: 10 }} onClick={() => window.quickLogin?.('admin')}>
                <span style={{ background: 'rgba(72,180,224,0.15)', color: 'var(--accent-light)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>ADMIN</span>
                Jefe de equipo / Administrador
              </button>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start', gap: 10 }} onClick={() => window.quickLogin?.('agent')}>
                <span style={{ background: 'rgba(128,255,218,0.1)', color: 'var(--green-text)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>AGENTE</span>
                Ana García — Módulo A
              </button>
              <button className="btn btn-ghost" style={{ justifyContent: 'flex-start', gap: 10 }} onClick={() => window.quickLogin?.('agent2')}>
                <span style={{ background: 'rgba(128,255,218,0.1)', color: 'var(--green-text)', borderRadius: 6, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>AGENTE</span>
                Carlos López — Módulo A
              </button>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--muted)', textAlign: 'center', maxWidth: 380, lineHeight: 1.6 }}>
          Al acceder aceptas el tratamiento de tus datos laborales según el{' '}
          <span style={{ color: 'var(--accent-light)', cursor: 'pointer' }}
            onClick={() => alert('Responsable: BJS Legal Services España\nFinalidad: Gestión de turnos\nBase legal: Art. 6.1.b RGPD\nDerechos: rrhh@bjslegal.com')}>
            Aviso de Privacidad
          </span>{' '}(RGPD / LOPDGDD).
        </div>
      </div>

      {/* HEADER */}
      <header className="header" id="mainHeader">
        <div className="header-logo">
          <span style={{ color: '#48b4e0', fontWeight: 800, letterSpacing: -1 }}>BJS</span>
          {' '}<span style={{ fontWeight: 400, color: '#6b8099', fontSize: 13 }}>· TurnoSync</span>
        </div>
        <div className="header-actions">
          <div id="adminActions" style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => window.openModal?.('modal-jefes')}>👥 Jefes</button>
            <button className="btn btn-ghost" onClick={() => window.openModal?.('modal-agentes')}>👤 Agentes</button>
            <button className="btn btn-ghost" onClick={() => window.openModal?.('modal-ausencia')}>⚠ Reportar ausencia</button>
            <button className="btn btn-ghost" onClick={() => window.openModal?.('modal-cambio')}>⇄ Solicitar cambio</button>
            <button className="btn btn-primary" onClick={() => window.openModal?.('modal-alerta')}>🔔 Alertar jefe</button>
          </div>
          <div id="agentActions" style={{ display: 'none', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => window.openModal?.('modal-ausencia')}>⚠ Reportar ausencia</button>
            <button className="btn btn-ghost" onClick={() => window.openModal?.('modal-cambio')}>⇄ Solicitar cambio</button>
          </div>
          <div className="user-pill" id="userPill" onClick={() => window.doLogout?.()}>
            <div className="user-avatar" id="userAvatar" style={{ background: 'rgba(72,180,224,0.2)', color: 'var(--accent-light)' }}>?</div>
            <span id="userLabel">—</span>
            <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 2 }}>· salir</span>
          </div>
        </div>
      </header>

      {/* TABS */}
      <div className="tabs-bar">
        <div className="tab active" onClick={e => window.switchModule?.(0, e.currentTarget)}>Módulo A — Banca</div>
        <div className="tab" onClick={e => window.switchModule?.(1, e.currentTarget)}>Módulo B — Seguros</div>
        <div className="tab" onClick={e => window.switchModule?.(2, e.currentTarget)}>Módulo C — Telco</div>
      </div>

      {/* SEMANA NAV — solo móvil */}
      <div className="week-nav-mobile">
        <button onClick={() => window.mobileWeekPrev?.()}>‹</button>
        <span id="mobile-week-label">Esta semana</span>
        <button onClick={() => window.mobileWeekNext?.()}>›</button>
      </div>

      {/* TOOLBAR */}
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="month-nav">
            <button className="nav-btn" onClick={() => window.changeMonth?.(-1)}>‹</button>
            <div className="month-label" id="monthLabel">Cargando...</div>
            <button className="nav-btn" onClick={() => window.changeMonth?.(1)}>›</button>
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-ghost btn-sm" onClick={() => window.openImportModal?.()}>📥 Importar</button>
          <button className="btn btn-ghost btn-sm" id="btnVoz" onClick={() => window.toggleVoice?.()}>🎤 Voz</button>
          <button className="btn btn-ghost btn-sm" id="btnToday" onClick={() => window.toggleTodayView?.()}>📅 Vista de hoy</button>
          <button className="btn btn-ghost btn-sm" id="btnBackups" onClick={() => window.openModal?.('modal-backups')} style={{ color: '#fb923c', borderColor: 'rgba(251,146,60,0.3)' }}>🟠 Backups</button>
          <button className="btn btn-ghost btn-sm" id="btnClone" onClick={() => window.cloneLastMonth?.()} style={{ display: 'none' }}>⎘ Replicar mes anterior</button>
          <button className="btn btn-ghost btn-sm" id="btnGenerar" onClick={() => window.generateRandom?.()} style={{ display: 'none' }}>⚡ Generar aleatorio</button>
          <button className="btn btn-ghost btn-sm" id="btnCancelar" onClick={() => window.cancelarEdicion?.()} style={{ display: 'none', color: 'var(--muted)' }}>✕ Cancelar</button>
          <button className="btn btn-sm" id="btnGuardar" onClick={() => window.guardarCambios?.()} style={{ display: 'none', background: '#166534', color: '#86efac', border: '1px solid #166534' }}>💾 Guardar cambios</button>
          <button className="btn btn-ghost btn-sm" id="btnEditar" onClick={() => window.activarEdicion?.()}>✏ Editar</button>
        </div>
      </div>

      {/* EDIT BANNER */}
      <div id="editBanner" style={{ display: 'none', margin: '0 24px 12px', padding: '10px 16px', borderRadius: 9, background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.35)', fontSize: 13, color: '#a5b4fc', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 15 }}>✏</span>
        <span><strong>Modo edición activo</strong> — haz clic en cualquier celda para cambiar el turno. Pulsa <strong>Guardar cambios</strong> cuando termines.</span>
      </div>

      {/* STATS */}
      <div className="stats-bar">
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(128,255,218,0.1)', color: 'var(--green-text)', borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700 }}>✦</div>
          <div><div className="stat-label">Agentes activos</div><div className="stat-value green" id="statActivos">—</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(144,208,245,0.1)', color: 'var(--shift-a-text)', borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>A</div>
          <div><div className="stat-label">Turno 9–17h hoy</div><div className="stat-value purple" id="statA">—</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(144,208,245,0.1)', color: 'var(--shift-b-text)', borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>B</div>
          <div><div className="stat-label">Turno 11–20h hoy</div><div className="stat-value purple" id="statB">—</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: 'rgba(253,230,138,0.1)', color: 'var(--yellow-text)', borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700 }}>!</div>
          <div><div className="stat-label">Ausencias hoy</div><div className="stat-value yellow" id="statAus">0</div></div>
        </div>
      </div>

      {/* AGENT BANNER */}
      <div className="agent-banner" id="agentBanner">
        <span style={{ fontSize: 18 }}>👤</span>
        <div><strong id="agentBannerName">—</strong> — estás viendo tu cronograma personal.</div>
      </div>

      {/* ALERT BANNER */}
      <div className="alert-banner" id="alertBanner">
        ⚠ <strong>Cobertura baja hoy:</strong> Solo 3 agentes en turno tarde — mínimo requerido: 5.
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => window.hideBanner?.()}>Descartar</button>
      </div>

      {/* TODAY VIEW */}
      <div className="today-view" id="todayView">
        <div className="today-header">
          <div className="today-date">Situación de <span id="todayDateLabel">hoy</span></div>
          <button className="btn btn-ghost btn-sm" onClick={() => window.toggleTodayView?.()}>✕ Cerrar vista</button>
        </div>
        <div id="todayAbsent"></div>
        <div className="today-grid" id="todayGrid"></div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span className="backup-dot"></span> Agente marcado como backup de emergencia</span>
        </div>
      </div>

      {/* LEGEND */}
      <div className="legend">
        <div className="legend-item"><div className="legend-chip chip-a">A</div> Turno mañana (9–17h)</div>
        <div className="legend-item"><div className="legend-chip chip-b">B</div> Turno tarde (11–20h)</div>
        <div className="legend-item"><div className="legend-chip chip-off">—</div> Libre</div>
        <div className="legend-item"><div className="legend-chip" style={{ background: 'var(--red)', color: 'var(--red-text)' }}>AUS</div> Ausencia</div>
        <div className="legend-item"><div className="legend-chip" style={{ background: '#c2410c', color: '#ffedd5', border: '1px dashed #fb923c', fontSize: 9 }}>⟳</div> En búsqueda</div>
      </div>

      {/* GRID */}
      <div className="grid-wrap">
        <table id="scheduleTable">
          <thead id="tableHead"></thead>
          <tbody id="tableBody"></tbody>
        </table>
      </div>

      {/* MODALES */}
      {/* Modal Acción */}
      <div className="overlay" id="modal-accion">
        <div className="modal" style={{ width: 500 }}>
          <div className="modal-title">¿Qué hacemos ahora?</div>
          <div className="modal-sub" id="accion-sub">Alerta enviada. Elige cómo gestionar la cobertura.</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 8 }}>
            <div style={{ background: 'var(--bg)', border: '1px solid #991b1b', borderRadius: 12, padding: 18, cursor: 'pointer' }} onClick={() => window.activarProtocolo?.()}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <div style={{ width: 36, height: 36, background: 'var(--red)', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>📣</div>
                <div><div style={{ fontSize: 14, fontWeight: 700 }}>Activar protocolo</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>Envío automático a agentes backup</div></div>
              </div>
              <div style={{ fontSize: 12, color: '#a1a1aa', lineHeight: 1.6 }}>El sistema contactará a todos los agentes backup disponibles hoy para cubrir el turno.</div>
              <div id="backup-list-preview" style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}></div>
            </div>
            <div style={{ background: 'var(--bg)', border: '1px solid var(--accent)', borderRadius: 12, padding: 18, cursor: 'pointer' }} onClick={() => window.gestionManual?.()}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                <div style={{ width: 36, height: 36, background: '#1e1b4b', borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🔍</div>
                <div><div style={{ fontSize: 14, fontWeight: 700 }}>Hacerme cargo</div><div style={{ fontSize: 12, color: 'var(--muted)' }}>Marcar turno como "en búsqueda" y gestionarlo</div></div>
              </div>
            </div>
          </div>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-accion')}>Cerrar sin acción</button>
          </div>
        </div>
      </div>

      {/* Modal Ausencia */}
      <div className="overlay" id="modal-ausencia">
        <div className="modal">
          <div className="modal-title">Reportar ausencia</div>
          <div className="modal-sub">Se enviará alerta al jefe de equipo por email y WhatsApp.</div>
          <div className="form-group"><label className="form-label">Agente</label><select className="form-control" id="aus-agente"></select></div>
          <div className="form-group"><label className="form-label">Fecha de ausencia</label><input type="date" className="form-control" id="aus-fecha" /></div>
          <div className="form-group"><label className="form-label">Motivo</label><select className="form-control"><option>Enfermedad</option><option>Asunto personal</option><option>Cita médica</option><option>Otro</option></select></div>
          <div className="form-group"><label className="form-label">Antelación</label><select className="form-control" id="aus-antelacion"><option value="24">Más de 24 horas de antelación</option><option value="0">Aviso en el momento (urgente)</option></select></div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-ausencia')}>Cancelar</button>
            <button className="btn btn-danger" onClick={() => window.reportarAusencia?.()}>Confirmar y avisar</button>
          </div>
        </div>
      </div>

      {/* Modal Cambio */}
      <div className="overlay" id="modal-cambio">
        <div className="modal">
          <div className="modal-title">Solicitar cambio de turno</div>
          <div className="modal-sub">El jefe de equipo recibirá la solicitud para aprobación.</div>
          <div className="form-group"><label className="form-label">Agente que solicita</label><select className="form-control" id="cambio-agente"></select></div>
          <div className="form-group"><label className="form-label">Fecha a cambiar</label><input type="date" className="form-control" /></div>
          <div className="form-group"><label className="form-label">Turno actual</label><select className="form-control"><option>A — Mañana (9–17h)</option><option>B — Tarde (11–20h)</option></select></div>
          <div className="form-group"><label className="form-label">Turno deseado</label><select className="form-control"><option>B — Tarde (11–20h)</option><option>A — Mañana (9–17h)</option></select></div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-cambio')}>Cancelar</button>
            <button className="btn btn-primary" onClick={() => window.solicitarCambio?.()}>Enviar solicitud</button>
          </div>
        </div>
      </div>

      {/* Modal Config */}
      <div className="overlay" id="modal-config">
        <div className="modal">
          <div className="modal-title">⚙ Configurar jefe de equipo</div>
          <div className="modal-sub">Estos datos se usarán para enviar alertas automáticas.</div>
          <div className="form-group"><label className="form-label">Nombre del jefe</label><input type="text" className="form-control" id="cfg-nombre" placeholder="Ej: Roberto Sánchez" /></div>
          <div className="form-group"><label className="form-label">Email</label><input type="email" className="form-control" id="cfg-email" placeholder="jefe@empresa.com" /></div>
          <div className="form-group"><label className="form-label">Teléfono (WhatsApp)</label><input type="tel" className="form-control" id="cfg-telefono" placeholder="+34 600 000 000" /></div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-config')}>Cancelar</button>
            <button className="btn btn-primary" onClick={() => window.guardarConfig?.()}>Guardar contacto</button>
          </div>
        </div>
      </div>

      {/* Modal Alerta */}
      <div className="overlay" id="modal-alerta">
        <div className="modal" style={{ width: 520 }}>
          <div className="modal-title">🔔 Alertar al jefe de equipo</div>
          <div className="modal-sub">Selecciona el tipo de alerta y revisa la vista previa antes de enviar.</div>
          <div className="form-group"><label className="form-label">Tipo de alerta</label><select className="form-control" id="alerta-tipo" onChange={() => window.actualizarPreview?.()}><option>Agente no conectado al sistema</option><option>Cobertura por debajo del mínimo</option><option>Ausencia de último momento</option><option>Turno sin cubrir</option></select></div>
          <div className="form-group"><label className="form-label">Agente afectado</label><select className="form-control" id="alerta-agente" onChange={() => window.actualizarPreview?.()}></select></div>
          <div className="form-group"><label className="form-label">Canal de notificación</label><select className="form-control" id="alerta-canal" onChange={() => window.actualizarPreview?.()}><option>Email + WhatsApp</option><option>Solo Email</option><option>Solo WhatsApp</option></select></div>
          <div className="form-group"><label className="form-label">Si el jefe no responde en...</label><select className="form-control" id="alerta-escalado"><option value="15">15 min → escalar a agentes backup</option><option value="30">30 min → escalar a agentes backup</option><option value="60">1 hora → escalar a agentes backup</option></select></div>
          <div id="alerta-destinatario" style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 10 }}>Destinatario</div>
            <div id="dest-info" style={{ fontSize: 13, color: 'var(--muted)' }}>Sin configurar — <span style={{ color: 'var(--accent-light)', cursor: 'pointer' }} onClick={() => { window.closeModal?.('modal-alerta'); window.openModal?.('modal-config'); }}>añadir jefe →</span></div>
          </div>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 10 }}>Vista previa del mensaje</div>
            <div id="preview-msg" style={{ fontSize: 13, lineHeight: 1.6, color: '#d4d4d8', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}></div>
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-alerta')}>Cancelar</button>
            <button className="btn btn-danger" onClick={() => window.enviarAlerta?.()}>Enviar alerta ahora</button>
          </div>
        </div>
      </div>

      {/* Modal Backups */}
      <div className="overlay" id="modal-backups">
        <div className="modal" style={{ width: 480 }}>
          <div className="modal-title">🟠 Agentes backup de emergencia</div>
          <div className="modal-sub">Selecciona quiénes pueden ser contactados para cubrir turnos.</div>
          <div id="backup-agent-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 380, overflowY: 'auto' }}></div>
          <div className="modal-actions" style={{ marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-backups')}>Cerrar</button>
            <button className="btn btn-primary" onClick={() => { window.closeModal?.('modal-backups'); showToast('Backups guardados ✓', 'success'); }}>Guardar</button>
          </div>
        </div>
      </div>

      {/* Modal Importar */}
      <div className="overlay" id="modal-import">
        <div className="modal" style={{ width: 540 }}>
          <div className="modal-title">📥 Importar horario</div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#0a0f1e', borderRadius: 8, padding: 4 }}>
            <button id="tab-csv" className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 13 }} onClick={() => window.switchImportTab?.('csv')}>📄 CSV / Excel</button>
            <button id="tab-foto" className="btn btn-ghost btn-sm" style={{ flex: 1, fontSize: 13 }} onClick={() => window.switchImportTab?.('foto')}>📷 Foto</button>
          </div>

          {/* Tab CSV */}
          <div id="import-tab-csv">
            <div style={{ background: '#0a0f1e', border: '1px solid #1e2d45', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 12, color: '#6b8099', lineHeight: 1.7 }}>
              <strong style={{ color: '#f0f4ff' }}>Formato esperado:</strong><br/>
              Columnas: <code style={{ color: '#48b4e0' }}>agente, dia, turno</code><br/>
              Turnos válidos: <code style={{ color: '#48b4e0' }}>A · B · OFF · AUS · BUS</code><br/>
              <button className="btn btn-ghost btn-sm" style={{ marginTop: 8, fontSize: 11 }} onClick={() => window.downloadPlantilla?.()}>⬇ Descargar plantilla del mes actual</button>
            </div>
            <div className="form-group">
              <label className="form-label">Subir archivo .csv</label>
              <input type="file" id="csv-file-input" accept=".csv,text/csv" className="form-control" style={{ cursor: 'pointer' }} onChange={() => window.importCSV?.()} />
            </div>
            <div className="form-group">
              <label className="form-label">O pega el CSV aquí</label>
              <textarea id="csv-input" className="form-control" rows={4} placeholder={"agente,dia,turno\nAna García,1,A\nCarlos López,1,B"} style={{ fontFamily: 'monospace', fontSize: 12 }} />
            </div>
            <div id="csv-error" style={{ color: '#fca5a5', fontSize: 12, marginBottom: 8 }}></div>
            <div id="csv-preview" style={{ marginBottom: 12 }}></div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-import')}>Cancelar</button>
              <button className="btn btn-ghost" onClick={() => window.importCSV?.()}>🔍 Previsualizar</button>
              <button className="btn btn-primary" id="btn-import-confirm" style={{ display: 'none' }} onClick={() => window.confirmImport?.()}>✓ Importar horario</button>
            </div>
          </div>

          {/* Tab Foto */}
          <div id="import-tab-foto" style={{ display: 'none' }}>
            <div style={{ background: '#0a0f1e', border: '1px solid #1e2d45', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 12, color: '#6b8099', lineHeight: 1.6 }}>
              📷 Sube una foto del horario físico (pizarra, papel, Excel…) y la IA extraerá los turnos automáticamente.
            </div>
            <div className="form-group">
              <label className="form-label">Selecciona imagen</label>
              <input type="file" id="foto-file-input" accept="image/*" className="form-control" style={{ cursor: 'pointer' }} onChange={() => window.previewFoto?.()} />
            </div>
            <div id="foto-preview-wrap" style={{ display: 'none', marginBottom: 12, textAlign: 'center' }}>
              <img id="foto-preview-img" src="" alt="preview" style={{ maxWidth: '100%', maxHeight: 200, borderRadius: 8, border: '1px solid #1e2d45' }} />
            </div>
            <div id="foto-error" style={{ color: '#fca5a5', fontSize: 12, marginBottom: 8 }}></div>
            <div id="foto-result" style={{ marginBottom: 12 }}></div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-import')}>Cancelar</button>
              <button className="btn btn-ghost" id="btn-foto-analizar" style={{ display: 'none' }} onClick={() => window.analizarFoto?.()}>🔍 Analizar con IA</button>
              <button className="btn btn-primary" id="btn-foto-confirm" style={{ display: 'none' }} onClick={() => window.confirmFoto?.()}>✓ Importar horario</button>
            </div>
          </div>

        </div>
      </div>

      {/* Modal Agentes */}
      <div className="overlay" id="modal-agentes">
        <div className="modal" style={{ width: 520 }}>
          <div className="modal-title">👤 Gestionar agentes</div>
          <div className="modal-sub">Añade o elimina agentes por módulo.</div>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 12 }}>Añadir nuevo agente</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <div><label className="form-label">Nombre completo</label><input type="text" className="form-control" id="new-agent-name" placeholder="Ej: Carmen Vidal" /></div>
              <div><label className="form-label">Módulo</label><select className="form-control" id="new-agent-module"><option value="0">Módulo A</option><option value="1">Módulo B</option><option value="2">Módulo C</option></select></div>
              <div><label className="form-label">Email</label><input type="email" className="form-control" id="new-agent-email" placeholder="agente@bjslegal.com" /></div>
              <div><label className="form-label">Teléfono</label><input type="tel" className="form-control" id="new-agent-tel" placeholder="+34 600 000 000" /></div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary btn-sm" onClick={() => window.addAgente?.()}>＋ Añadir</button>
            </div>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 10 }}>Agentes actuales</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }} id="agentes-mod-tabs">
            <button className="btn btn-primary btn-sm" onClick={e => window.switchAgentesTab?.(0, e.currentTarget)}>Módulo A</button>
            <button className="btn btn-ghost btn-sm" onClick={e => window.switchAgentesTab?.(1, e.currentTarget)}>Módulo B</button>
            <button className="btn btn-ghost btn-sm" onClick={e => window.switchAgentesTab?.(2, e.currentTarget)}>Módulo C</button>
          </div>
          <div id="agentes-list" style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}></div>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-agentes')}>Cerrar</button>
          </div>
        </div>
      </div>

      {/* Modal Jefes */}
      <div className="overlay" id="modal-jefes">
        <div className="modal" style={{ width: 520 }}>
          <div className="modal-title">👥 Jefes de equipo</div>
          <div className="modal-sub">Gestiona los usuarios con rol de jefe/administrador.</div>
          <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 12 }}>Añadir nuevo jefe</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
              <div><label className="form-label">Nombre completo</label><input type="text" className="form-control" id="new-jefe-name" placeholder="Ej: Marta López" /></div>
              <div><label className="form-label">Email de acceso</label><input type="email" className="form-control" id="new-jefe-email" placeholder="jefe@bjslegal.com" /></div>
              <div><label className="form-label">Contraseña</label><input type="password" className="form-control" id="new-jefe-pass" placeholder="Mínimo 6 caracteres" /></div>
              <div><label className="form-label">Teléfono (alertas)</label><input type="tel" className="form-control" id="new-jefe-tel" placeholder="+34 600 000 000" /></div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-primary btn-sm" onClick={() => window.addJefe?.()}>＋ Añadir jefe</button>
            </div>
          </div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--muted)', marginBottom: 10 }}>Jefes activos</div>
          <div id="jefes-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}></div>
          <div className="modal-actions" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-jefes')}>Cerrar</button>
            <button className="btn btn-ghost" onClick={() => window.openModal?.('modal-config')} style={{ marginLeft: 4 }}>⚙ Configurar alertas</button>
          </div>
        </div>
      </div>

      {/* PANEL BACKDROP */}
      <div className="panel-backdrop" id="panelBackdrop" onClick={() => window.closePanel?.()}></div>

      {/* PANEL HISTORIAL */}
      <div className="side-panel" id="sidePanel">
        <div className="panel-header">
          <div>
            <div className="panel-agent-name" id="panelAgentName">—</div>
            <div className="panel-agent-meta" id="panelAgentMeta">—</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
            <button className="panel-close" onClick={() => window.closePanel?.()}>×</button>
            <button onClick={() => window.eliminarDatosAgente?.()} title="Eliminar todos los datos (GDPR Art.17)"
              style={{ width: 32, height: 32, borderRadius: 8, background: 'rgba(127,29,29,0.2)', border: '1px solid rgba(127,29,29,0.4)', color: '#fca5a5', cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🗑</button>
          </div>
        </div>
        <div className="panel-tabs">
          <div className="panel-tab active" onClick={e => window.switchPanelTab?.('estadisticas', e.currentTarget)}>Estadísticas</div>
          <div className="panel-tab" onClick={e => window.switchPanelTab?.('disciplina', e.currentTarget)}>Disciplina</div>
          <div className="panel-tab" onClick={e => window.switchPanelTab?.('ausencias', e.currentTarget)}>Ausencias</div>
        </div>
        <div className="panel-body">
          <div id="tab-estadisticas">
            <div className="mini-stats" id="panelStats"></div>
            <div className="historial-section">
              <div className="historial-section-title">Turno actual del mes</div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>Cada punto = un día laboral</div>
              <div className="shift-bar" id="panelShiftBar"></div>
              <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                <span style={{ fontSize: 11, color: 'var(--shift-a-text)' }}>■ Turno A</span>
                <span style={{ fontSize: 11, color: 'var(--shift-b-text)' }}>■ Turno B</span>
                <span style={{ fontSize: 11, color: 'var(--red-text)' }}>■ Ausencia</span>
              </div>
            </div>
            <div className="historial-section">
              <div className="historial-section-title">Últimas incidencias</div>
              <div id="panelUltimasIncidencias"></div>
            </div>
          </div>
          <div id="tab-disciplina" style={{ display: 'none' }}>
            <div className="historial-section">
              <div className="historial-section-title">
                Registro disciplinario
                <button className="btn btn-ghost btn-sm" onClick={() => window.toggleAddForm?.('form-disciplina')}>+ Añadir</button>
              </div>
              <div className="add-record-form" id="form-disciplina">
                <div className="form-group"><label className="form-label">Tipo</label><select className="form-control" id="disc-tipo"><option value="amonestacion">Amonestación verbal</option><option value="amonestacion_escrita">Amonestación escrita</option><option value="apercibimiento">Apercibimiento formal</option><option value="suspension">Suspensión de empleo</option></select></div>
                <div className="form-group"><label className="form-label">Fecha</label><input type="date" className="form-control" id="disc-fecha" /></div>
                <div className="form-group"><label className="form-label">Motivo / Observaciones</label><textarea className="form-control" id="disc-nota" rows="2" placeholder="Describe brevemente el motivo..."></textarea></div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => window.toggleAddForm?.('form-disciplina')}>Cancelar</button>
                  <button className="btn btn-danger btn-sm" onClick={() => window.agregarDisciplina?.()}>Registrar</button>
                </div>
              </div>
              <div id="listaDisciplina"></div>
            </div>
          </div>
          <div id="tab-ausencias" style={{ display: 'none' }}>
            <div className="historial-section">
              <div className="historial-section-title">
                Historial de ausencias
                <button className="btn btn-ghost btn-sm" onClick={() => window.toggleAddForm?.('form-ausencia-hist')}>+ Añadir</button>
              </div>
              <div className="add-record-form" id="form-ausencia-hist">
                <div className="form-group"><label className="form-label">Fecha</label><input type="date" className="form-control" id="ah-fecha" /></div>
                <div className="form-group"><label className="form-label">Tipo</label><select className="form-control" id="ah-tipo"><option>Enfermedad justificada</option><option>Enfermedad no justificada</option><option>Asunto personal</option><option>Vacaciones</option><option>Falta injustificada</option></select></div>
                <div className="form-group"><label className="form-label">Notas</label><input type="text" className="form-control" id="ah-nota" placeholder="Opcional" /></div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => window.toggleAddForm?.('form-ausencia-hist')}>Cancelar</button>
                  <button className="btn btn-primary btn-sm" onClick={() => window.agregarAusenciaHist?.()}>Registrar</button>
                </div>
              </div>
              <div id="listaAusencias"></div>
            </div>
          </div>
        </div>
      </div>

      {/* MOBILE NAV BAR */}
      <nav className="mobile-nav" id="mobileNav">
        <button onClick={() => window.openModal?.('modal-ausencia')}>
          <span className="nav-icon">⚠️</span>Ausencia
        </button>
        <button onClick={() => window.openModal?.('modal-cambio')}>
          <span className="nav-icon">⇄</span>Cambio
        </button>
        <button onClick={() => window.openModal?.('modal-alerta')} className="nav-alert">
          <span className="nav-icon">🔔</span>Alertar
        </button>
        <button onClick={() => window.openModal?.('modal-agentes')}>
          <span className="nav-icon">👤</span>Agentes
        </button>
        <button onClick={() => window.openModal?.('modal-ayuda')}>
          <span className="nav-icon">❓</span>Ayuda
        </button>
      </nav>

      {/* FOOTER */}
      <footer style={{ textAlign: 'center', padding: '18px 24px', fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--border)', marginTop: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, flexWrap: 'wrap' }}>
        <span>© 2026 BJS TurnoSync · BJS Legal Services España</span>
        <a href="/privacidad" target="_blank" style={{ color: 'var(--accent-light)', textDecoration: 'none' }}>🔒 Política de privacidad (GDPR)</a>
        <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 10px' }} onClick={() => window.openModal?.('modal-ayuda')}>❓ Ayuda / Contacto</button>
      </footer>

      {/* Modal Ayuda / FAQ / Contacto */}
      <div className="overlay" id="modal-ayuda">
        <div className="modal" style={{ width: 560 }}>
          <div className="modal-title">❓ Ayuda y contacto</div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: '#0a0f1e', borderRadius: 8, padding: 4 }}>
            <button id="tab-faq" className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 13 }} onClick={() => window.switchAyudaTab?.('faq')}>📋 Preguntas frecuentes</button>
            <button id="tab-contacto" className="btn btn-ghost btn-sm" style={{ flex: 1, fontSize: 13 }} onClick={() => window.switchAyudaTab?.('contacto')}>✉ Contactar soporte</button>
          </div>

          {/* FAQ */}
          <div id="ayuda-tab-faq" style={{ maxHeight: 420, overflowY: 'auto' }}>
            {[
              ['¿Cómo añado un turno?', 'Pulsa "✏ Editar" y haz clic en cualquier celda del grid para cambiar el turno del agente en ese día.'],
              ['¿Cómo importo un horario desde Excel o CSV?', 'Pulsa "📥 Importar" en el toolbar. Descarga la plantilla, rellénala y súbela. También puedes pegar el CSV directamente.'],
              ['¿Puedo subir una foto del horario?', 'Sí. En "📥 Importar" elige la pestaña "📷 Foto", sube la imagen y la IA extraerá los turnos automáticamente.'],
              ['¿Cómo uso los comandos de voz?', 'Pulsa "🎤 Voz" y habla de forma natural. Ejemplos: "Ana turno A del 1 al 10", "Carlos libre los lunes", "guardar".'],
              ['¿Cómo reporto una ausencia?', 'Pulsa "⚠ Reportar ausencia" en el navbar. Se enviará una alerta automática al jefe de equipo.'],
              ['¿Qué son los agentes backup?', 'Son agentes disponibles para cubrir turnos en caso de ausencia urgente. Márcalos desde el botón "🟠 Backups".'],
              ['¿Cómo configuro las alertas al jefe?', 'Ve a "Jefes" → "Configurar alertas" y añade el email y teléfono del jefe.'],
              ['¿La app cumple con el GDPR?', 'Sí. Todos los datos se almacenan en servidores europeos (Irlanda). Consulta nuestra política de privacidad en el footer.'],
              ['¿Cómo elimino los datos de un agente?', 'Abre el panel del agente haciendo clic en su nombre → botón "Eliminar datos (GDPR Art.17)".'],
            ].map(([q, a], i) => (
              <div key={i} style={{ borderBottom: '1px solid var(--border)', padding: '12px 0' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text)' }}>{q}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.6 }}>{a}</div>
              </div>
            ))}
          </div>

          {/* Contacto */}
          <div id="ayuda-tab-contacto" style={{ display: 'none' }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>¿Tienes alguna duda o problema? Envíanos un mensaje y te responderemos lo antes posible.</div>
            <div className="form-group"><label className="form-label">Tu nombre</label><input type="text" className="form-control" id="contacto-nombre" placeholder="Ej: Ana García" /></div>
            <div className="form-group"><label className="form-label">Tu email</label><input type="email" className="form-control" id="contacto-email" placeholder="tu@email.com" /></div>
            <div className="form-group"><label className="form-label">Mensaje</label><textarea className="form-control" id="contacto-mensaje" rows={4} placeholder="Describe tu consulta o problema…" /></div>
            <div id="contacto-status" style={{ fontSize: 12, marginBottom: 8 }}></div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-ayuda')}>Cerrar</button>
              <button className="btn btn-primary" onClick={() => window.enviarContacto?.()}>✉ Enviar mensaje</button>
            </div>
          </div>

          <div className="modal-actions" id="faq-actions">
            <button className="btn btn-ghost" onClick={() => window.closeModal?.('modal-ayuda')}>Cerrar</button>
          </div>
        </div>
      </div>

      {/* TOASTS */}
      <div className="toast-container" id="toastContainer"></div>
    </>
  );
}
