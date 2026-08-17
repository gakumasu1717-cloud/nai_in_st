/**
 * NaiStudio — SillyTavern 안의 NAI 브라우저
 *
 *  · 이미지를 드롭하면 PNG 메타데이터를 읽어 프롬프트/UC/캐릭터/파라미터를 그대로 복원
 *  · 그 상태를 "그림체"로 저장해두고 언제든 다시 꺼내 씀
 *  · 패널 안에서 태그·UC·캐릭터 프롬프트를 직접 수정하며 계속 뽑기
 *
 * 참고: AutoPic (SillyGgu) 의 NAI 프록시 구조.
 */

import {
    extension_settings, getContext, eventSource, event_types, callGenericPopup, POPUP_TYPE,
} from './lib/st.js';
import {
    getSettings, save, listStyles, getStyle, upsertStyle, deleteStyle, duplicateStyle,
    allStyleTags, addHistory, clearHistory,
    listCharPresets, getCharPreset, upsertCharPreset, deleteCharPreset, duplicateCharPreset,
    allCharPresetTags, exportAll, importAll,
    makeThumbnail, blobToBase64, DEFAULT_PARAMS, EXTENSION_NAME,
} from './lib/store.js';
import {
    MODELS, SAMPLERS, SCHEDULERS, SIZE_PRESETS, BASE_TAGS, isV4Model,
    normalizeTags, subtractPrompt, resolvePrompt, adjustWeight, getTagRangeAtCaret, splitTags,
} from './lib/prompt-tools.js';
import { extractImageMetadata } from './lib/png-metadata.js';
import {
    buildPayload, generateImage, saveImageToServer, sendImageToChat, letterboxReference,
    pingOwnPlugin, probeAutopicPlugin, getBackendAvailability, resetBackendAvailability, defaultCenter, BACKEND,
    isChatOpen, MAX_DIRECTOR_REFERENCES, CENTER_STEPS, snapCenter,
    checkAnlasCost, applyAnlasGuard, FREE_TIER,
} from './lib/nai-client.js';

const extensionFolderPath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
/** panel.html 캐시 무효화용 — UI를 바꿀 때 올린다 */
const PANEL_VERSION = 2;

/** 패널 작업 상태 (팝업이 닫혀도 유지) */
let state = null;
/** 이번 세션에서 생성한 이미지 (base64 원본 포함) */
let sessionGallery = [];
/** 시드 입력이 비어 있거나 음수면 랜덤. UI에는 -1로 표기한다. */
const RANDOM_SEED = -1;

/** 뷰어에 크게 띄우고 있는 이미지의 인덱스 (0 = 가장 최근) */
let viewerIndex = 0;
let isGenerating = false;
let lastSeed = '';
/** 동시에 열려 있는 패널 수 (토스트 위치 복원 타이밍용) */
let openPanelCount = 0;
/**
 * 생성 바 내부 요소 조회.
 * 바는 팝업 컨트롤 줄로 옮겨져 패널의 자식이 아니게 되므로, 패널에 직접 물려둔
 * 참조($p.data('ssBar'))로 찾는다. 전역 변수로 들고 있으면 패널을 다시 열거나
 * 닫는 순간 stale/null 이 되어 상태 갱신이 조용히 실패한다.
 */
function bar($p, selector) {
    const $bar = $p?.data('ssBar');
    return $bar?.length ? $bar.find(selector) : $p?.find(selector) ?? $();
}

/* ══════════════════════════ 상태 ══════════════════════════ */

function blankState() {
    const settings = getSettings();
    return {
        ...structuredClone(DEFAULT_PARAMS),
        ...structuredClone(settings.defaults ?? {}),
        prompt: '',
        negative: '',
        seed: RANDOM_SEED,
        characters: [],
        vibes: [],
        vibeEnabled: false,
        ref: { enabled: false, base64: '', thumb: '', strength: 1.0, fidelity: 1.0, mode: 'character&style' },
    };
}

function getState() {
    if (!state) {
        const saved = getSettings().last;
        state = saved ? { ...blankState(), ...structuredClone(saved) } : blankState();
        if (!Array.isArray(state.characters)) state.characters = [];
        if (!Array.isArray(state.vibes)) state.vibes = [];
        if (!state.ref) state.ref = blankState().ref;
        // 예전 버전은 랜덤 시드를 빈 문자열로 저장했다 → -1 로 통일
        if (String(state.seed).trim() === '' || !Number.isInteger(Number(state.seed))) {
            state.seed = RANDOM_SEED;
        }
    }
    return state;
}

function persistState() {
    getSettings().last = structuredClone(getState());
    save();
}

/* ══════════════════════════ 유틸 ══════════════════════════ */

function toast(type, message, title = 'NaiStudio') {
    if (typeof toastr !== 'undefined') toastr[type](message, title);
    else console.log(`[NaiStudio] ${message}`);
}

function dataUrl(base64) {
    return base64?.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fillSelect($select, options, selected) {
    $select.empty();
    for (const option of options) {
        const value = typeof option === 'string' ? option : option.id ?? option.value;
        const label = typeof option === 'string' ? option : option.label;
        $select.append(`<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`);
    }
    if (selected !== undefined) $select.val(selected);
}

/**
 * 파일 선택창을 연다.
 *
 * 모바일에서 사진을 고르고 돌아오면 팝업이 닫히는 문제가 있다.
 * 파일 선택기가 닫히면서 발생한 클릭/포커스 이벤트가 팝업의 "바깥 클릭"으로
 * 잡히기 때문이다. 잠시 동안 팝업 배경으로 가는 클릭을 캡처 단계에서 막는다.
 */
function openFilePicker($p, $input) {
    const dialog = $p.closest('dialog, .popup, .mock-popup')[0];

    if (dialog) {
        const block = (event) => {
            // 팝업 배경(다이얼로그 자신)으로 가는 클릭만 차단한다
            if (event.target === dialog) {
                event.stopPropagation();
                event.preventDefault();
            }
        };
        dialog.addEventListener('click', block, true);
        setTimeout(() => dialog.removeEventListener('click', block, true), 1500);
    }

    $input.trigger('click');
}

async function fileToImageInfo(file) {
    const base64 = await blobToBase64(file);
    const thumb = await makeThumbnail(base64).catch(() => '');
    return { base64, thumb };
}

/* ══════════════════════════ 패널 열기 ══════════════════════════ */

let panelHtmlCache = null;

/**
 * 모바일에서 패널이 열리자마자 닫히던 문제:
 * 메뉴 항목을 탭한 그 클릭이 계속 전파돼서 새로 뜬 팝업의 바깥 클릭으로 잡힌다.
 * 전파를 끊고 한 틱 뒤에 열어서 원래 이벤트가 완전히 끝난 뒤 팝업이 뜨게 한다.
 */
function openPanelFromEvent(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    if (openPanelCount > 0) return;   // 이미 열려 있으면 중복으로 열지 않는다

    setTimeout(() => openPanel(), 60);
}

async function openPanel() {
    if (!panelHtmlCache) {
        panelHtmlCache = await $.get(`${extensionFolderPath}/panel.html?v=${PANEL_VERSION}`);
    }

    const $panel = $(panelHtmlCache);
    bindPanel($panel);
    syncUiFromState($panel);

    // 패널이 열려 있는 동안에는 토스트를 위쪽으로 (하단 생성 바와 겹침 방지)
    openPanelCount++;
    $('body').addClass('ss-panel-open');

    callGenericPopup($panel, POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: '닫기',
    }).finally(() => {
        openPanelCount = Math.max(0, openPanelCount - 1);
        if (openPanelCount === 0) $('body').removeClass('ss-panel-open');
        persistState();
    });

    mountActionBar($panel);
    refreshBackendStatus($panel);
}

/**
 * 생성 바를 팝업의 컨트롤 줄(= '닫기' 버튼과 같은 레이어)로 옮긴다.
 * 팝업 구조를 못 찾으면 패널 하단 sticky 상태로 그대로 둔다.
 */
function mountActionBar($panel, attempt = 0) {
    // 바 참조는 bindPanel에서 이미 $panel에 물려뒀다. 여기서 다시 찾지 않는다
    // (옮긴 뒤에는 $panel.find로 찾을 수 없기 때문).
    const $bar = $panel.data('ssBar');
    if (!$bar?.length) return;

    if ($bar.hasClass('ss-in-controls')) return;   // 이미 옮겼으면 끝

    const $dialog = $panel.closest('dialog, .popup, .mock-popup');
    const $controls = $dialog.find('.popup-controls, .mock-popup-controls').first();

    if (!$controls.length) {
        // 팝업이 아직 DOM에 붙기 전일 수 있으므로 몇 번 재시도
        if (attempt < 5) {
            setTimeout(() => mountActionBar($panel, attempt + 1), 60);
            return;
        }

        // 끝내 못 찾으면 화면 아래에 띄워둔다 (패널 맨 끝에 숨어버리는 것 방지)
        console.warn('[NaiStudio] 팝업 컨트롤 줄을 찾지 못해 생성 바를 화면 하단에 고정합니다.');
        $bar.addClass('ss-floating');
        updateSaveHint($panel);
        updateSeedChip($panel);
        updateAnlasChip($panel);
        return;
    }

    $controls.addClass('ss-controls-host').prepend($bar);
    $bar.addClass('ss-in-controls').removeClass('ss-floating');

    // 옮겨놓고도 실제로 화면에 안 잡히면(레이아웃이 다른 ST 테마 등) 띄우기로 되돌린다
    setTimeout(() => {
        const rect = $bar[0]?.getBoundingClientRect();
        if (!rect || rect.height < 8 || rect.bottom < 0 || rect.top > window.innerHeight) {
            console.warn('[NaiStudio] 생성 바가 화면에 보이지 않아 하단 고정으로 전환합니다.');
            $bar.addClass('ss-floating');
        }
    }, 300);

    updateSaveHint($panel);
    updateSeedChip($panel);
    updateAnlasChip($panel);
}

/* ══════════════════════════ UI ↔ 상태 ══════════════════════════ */

const FIELD_MAP = {
    prompt: '#ss_prompt',
    negative: '#ss_negative',
    model: '#ss_model',
    width: '#ss_width',
    height: '#ss_height',
    steps: '#ss_steps',
    scale: '#ss_scale',
    cfg_rescale: '#ss_cfg_rescale',
    sampler: '#ss_sampler',
    scheduler: '#ss_scheduler',
    seed: '#ss_seed',
};

const CHECK_MAP = {
    variety_boost: '#ss_variety',
    decrisper: '#ss_decrisper',
    sm: '#ss_sm',
    sm_dyn: '#ss_sm_dyn',
    use_coords: '#ss_use_coords',
};

function syncUiFromState($p) {
    const s = getState();
    const settings = getSettings();

    fillSelect($p.find('#ss_model'), MODELS, s.model);
    fillSelect($p.find('#ss_sampler'), SAMPLERS, s.sampler);
    fillSelect($p.find('#ss_scheduler'), SCHEDULERS, s.scheduler);

    const $size = $p.find('#ss_size');
    $size.empty().append('<option value="">직접 입력</option>');
    for (const preset of SIZE_PRESETS) {
        $size.append(`<option value="${preset.width}x${preset.height}">${escapeHtml(preset.label)}</option>`);
    }
    $size.val(`${s.width}x${s.height}`);

    const $uc = $p.find('#ss_uc_preset');
    $uc.empty().append('<option value="">UC 프리셋…</option>');
    for (const name of Object.keys(settings.ucPresets ?? {})) {
        $uc.append(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
    }

    for (const [key, selector] of Object.entries(FIELD_MAP)) $p.find(selector).val(s[key] ?? '');
    for (const [key, selector] of Object.entries(CHECK_MAP)) $p.find(selector).prop('checked', !!s[key]);

    $p.find('#ss_vibe_enabled').prop('checked', !!s.vibeEnabled);

    $p.find('#ss_backend_select').val(settings.backend ?? 'auto');
    $p.find('#ss_auto_normalize').prop('checked', settings.autoNormalize !== false);
    $p.find('#ss_anlas_guard').prop('checked', settings.anlasGuard !== false);
    $p.find('#ss_auto_save').prop('checked', settings.autoSave !== false);
    $p.find('#ss_save_folder').val(settings.saveFolder ?? 'NaiStudio');
    $p.find('#ss_keep_history').val(settings.keepHistory ?? 40);
    updateSaveHint($p);

    renderAppliedStyle($p);
    applyCollapsedState($p);
    renderCharacters($p);
    renderStyleGrid($p);
    renderCharPresets($p);
    renderVibes($p);
    renderReferences($p);
    renderGallery($p);
}

function readUiToState($p) {
    const s = getState();
    for (const [key, selector] of Object.entries(FIELD_MAP)) {
        const value = $p.find(selector).val();
        s[key] = ['width', 'height', 'steps', 'scale', 'cfg_rescale'].includes(key) ? Number(value) : value;
    }
    for (const [key, selector] of Object.entries(CHECK_MAP)) s[key] = $p.find(selector).is(':checked');
    s.vibeEnabled = $p.find('#ss_vibe_enabled').is(':checked');
    return s;
}

/* ══════════════════════════ 렌더러 ══════════════════════════ */

function renderCharacters($p) {
    const s = getState();
    const $wrap = $p.find('#ss_characters').empty();

    s.characters.forEach((character, index) => {
        const center = character.center ?? defaultCenter(index, s.characters.length);
        const $card = $(`
            <div class="ss-char" data-index="${index}">
                <div class="ss-char-head">
                    <label class="ss-checkline"><input type="checkbox" class="ss-char-enabled" ${character.enabled !== false ? 'checked' : ''}></label>
                    <input type="text" class="text_pole ss-char-name" placeholder="캐릭터 ${index + 1}" value="${escapeHtml(character.name ?? '')}">
                    ${character.ref?.base64 ? '<span class="ss-char-refmark" title="레퍼런스 탭에서 관리합니다"><i class="fa-solid fa-user-tag"></i> 레퍼런스</span>' : ''}
                    <div class="ss-char-actions">
                        <span class="ss-linkbtn ss-char-save" title="이 캐릭터를 저장"><i class="fa-solid fa-floppy-disk"></i></span>
                        <span class="ss-linkbtn ss-char-up" title="위로"><i class="fa-solid fa-arrow-up"></i></span>
                        <span class="ss-linkbtn ss-char-down" title="아래로"><i class="fa-solid fa-arrow-down"></i></span>
                        <span class="ss-linkbtn ss-char-remove" title="삭제"><i class="fa-solid fa-trash"></i></span>
                    </div>
                </div>
                <div class="ss-char-texts">
                    <textarea class="text_pole textarea_compact ss-char-prompt ss-ac" rows="2" placeholder="이 캐릭터의 태그">${escapeHtml(character.prompt ?? '')}</textarea>
                    <textarea class="text_pole textarea_compact ss-char-uc" rows="1" placeholder="이 캐릭터 전용 UC (선택)">${escapeHtml(character.uc ?? '')}</textarea>
                </div>
                <div class="ss-char-pos">
                    <span class="ss-char-pos-label">위치</span>
                    ${centerGridHtml(center)}
                    <span class="ss-char-pos-value">${center.x.toFixed(1)} , ${center.y.toFixed(1)}</span>
                </div>
            </div>
        `);
        $wrap.append($card);
    });

    updateReferenceSummary($p);

    $p.find('#ss_char_count').text(s.characters.length ? `(${s.characters.length}명)` : '');
    const backend = getSettings().backend;
    const availability = getBackendAvailability();
    const nativeOnly = backend === BACKEND.NATIVE
        || (backend === 'auto' && availability[BACKEND.OWN] === false && availability[BACKEND.AUTOPIC] === false);
    $p.find('#ss_char_warn').prop('hidden', !(nativeOnly && s.characters.length > 0));
}

/* ── 접기/펼치기 ────────────────────────────────────────── */

/** 저장된 접힘 상태를 화면에 반영 */
function applyCollapsedState($p) {
    const collapsed = getSettings().collapsed ?? {};
    $p.find('[data-collapse]').each(function () {
        $(this).toggleClass('ss-collapsed', !!collapsed[$(this).data('collapse')]);
    });
    updateCollapsedSummaries($p);
}

/** 접혀 있을 때 안에 뭐가 들었는지 헤더에 요약해서 보여준다 */
function updateCollapsedSummaries($p) {
    const s = getState();

    const summaries = {
        chars: s.characters.length ? `${s.characters.length}명` : '',
        vibeSection: s.vibes.filter(v => v.enabled !== false).length
            ? `${s.vibes.filter(v => v.enabled !== false).length}장`
            : '',
        refSection: s.ref?.base64 ? (s.ref.enabled ? '사용 중' : '꺼짐') : '',
        prompt: splitTags(s.prompt).length ? `태그 ${splitTags(s.prompt).length}개` : '',
        uc: splitTags(s.negative).length ? `태그 ${splitTags(s.negative).length}개` : '',
        params: `${s.width}×${s.height} · ${s.steps}steps`,
    };

    for (const [key, text] of Object.entries(summaries)) {
        const $head = $p.find(`[data-collapse="${key}"] .ss-collapse-head`);
        $head.find('.ss-collapse-summary').remove();
        if (text && $head.closest('[data-collapse]').hasClass('ss-collapsed')) {
            $head.append(`<span class="ss-collapse-summary">${escapeHtml(text)}</span>`);
        }
    }
}

/** 지금 어떤 그림체가 적용돼 있는지 상단에 표시 */
function renderAppliedStyle($p) {
    const applied = getState().appliedStyle;
    const $chip = $p.find('#ss_applied_style');

    if (!applied?.name) {
        $chip.prop('hidden', true).empty();
        return;
    }

    $chip.prop('hidden', false).html(`
        <i class="fa-solid fa-palette"></i>
        <span class="ss-applied-name" title="${escapeHtml(applied.positive ?? '')}">${escapeHtml(applied.name)}</span>
        <span class="ss-linkbtn ss-applied-clear" title="이 그림체 태그를 프롬프트에서 빼기"><i class="fa-solid fa-xmark"></i></span>
    `);
}

/** NAI와 동일한 5×5 위치 격자 */
function centerGridHtml(center) {
    const snapped = snapCenter(center);
    const cells = [];

    for (const y of CENTER_STEPS) {
        for (const x of CENTER_STEPS) {
            const active = Math.abs(x - snapped.x) < 0.01 && Math.abs(y - snapped.y) < 0.01;
            cells.push(`<span class="ss-grid-cell${active ? ' active' : ''}" data-x="${x}" data-y="${y}" title="${x.toFixed(1)}, ${y.toFixed(1)}"></span>`);
        }
    }

    return `<div class="ss-char-grid" title="캐릭터 위치 (NAI와 동일한 5×5 격자)">${cells.join('')}</div>`;
}

/** 전역 + 캐릭터 레퍼런스가 몇 장 붙어 있는지 요약해서 보여준다 */
function updateReferenceSummary($p) {
    const s = getState();
    const globalRef = s.ref?.enabled && s.ref?.base64 ? 1 : 0;
    const charRefs = s.characters.filter(c => c.enabled !== false && c.ref?.base64 && c.ref.enabled !== false).length;
    const total = globalRef + charRefs;

    const $summary = $p.find('#ss_ref_summary');
    if (!$summary.length) return;

    if (total === 0) {
        $summary.text('레퍼런스 없음');
        $summary.removeClass('ss-warn');
        return;
    }

    $summary.text(`레퍼런스 ${total}장 (전체 ${globalRef} + 캐릭터 ${charRefs})${total > MAX_DIRECTOR_REFERENCES ? ` — ${MAX_DIRECTOR_REFERENCES}장 초과분은 전송되지 않음` : ''}`);
    $summary.toggleClass('ss-warn', total > MAX_DIRECTOR_REFERENCES);
}

function styleCardHtml(style) {
    // 값이 비어 있어도 카드가 깨지지 않게 (렌더링이 죽으면 그 목록의 버튼이 전부 먹통이 된다)
    const positive = String(style.positive ?? '');
    const thumb = style.thumb
        ? `<img src="${style.thumb}" alt="">`
        : '<div class="ss-style-nothumb"><i class="fa-solid fa-palette"></i></div>';
    const tags = (style.tags ?? []).map(t => `<span class="ss-chip">${escapeHtml(t)}</span>`).join('');

    return `<div class="ss-style-card" data-id="${style.id}">
        <div class="ss-style-thumb">${thumb}
            <span class="ss-style-fav ${style.favorite ? 'on' : ''}" title="즐겨찾기"><i class="fa-solid fa-star"></i></span>
        </div>
        <div class="ss-style-body">
            <div class="ss-style-name">${escapeHtml(style.name)}</div>
            <div class="ss-style-tags">${tags}</div>
            <div class="ss-style-prompt" title="${escapeHtml(positive)}">${escapeHtml(positive.slice(0, 120))}</div>
        </div>
        <div class="ss-style-actions">
            <div class="menu_button ss-mini caution ss-style-del">삭제</div>
            <div class="menu_button ss-mini ss-style-edit">편집</div>
            <div class="menu_button ss-mini ss-style-dup">복제</div>
            <div class="menu_button ss-mini ss-style-apply" title="태그·UC·파라미터·캐릭터를 한 번에 적용">적용</div>
        </div>
    </div>`;
}

function renderStyleGrid($p) {
    const query = $p.find('#ss_style_search').val() ?? '';
    const tag = $p.find('#ss_style_tag_filter').val() ?? '';
    const favoriteOnly = $p.find('#ss_style_fav_only').is(':checked');
    const styles = listStyles({ query, tag, favoriteOnly });

    const $filter = $p.find('#ss_style_tag_filter');
    const current = $filter.val();
    $filter.empty().append('<option value="">모든 태그</option>');
    for (const t of allStyleTags()) $filter.append(`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
    $filter.val(current ?? '');

    $p.find('#ss_style_grid').html(
        styles.length
            ? styles.map(s => styleCardHtml(s)).join('')
            : '<div class="ss-empty">조건에 맞는 그림체가 없습니다. 이미지를 드롭해서 하나 만들어보세요.</div>',
    );
}

/** 캐릭터 프리셋 카드 */
function charPresetCardHtml(preset) {
    const prompt = String(preset.prompt ?? '');
    const thumb = preset.thumb
        ? `<img src="${preset.thumb}" alt="">`
        : '<div class="ss-style-nothumb"><i class="fa-solid fa-user"></i></div>';
    const tags = (preset.tags ?? []).map(t => `<span class="ss-chip">${escapeHtml(t)}</span>`).join('');

    return `<div class="ss-style-card ss-char-card" data-id="${preset.id}">
        <div class="ss-style-thumb">${thumb}
            <span class="ss-charp-fav ${preset.favorite ? 'on' : ''}" title="즐겨찾기"><i class="fa-solid fa-star"></i></span>
        </div>
        <div class="ss-style-body">
            <div class="ss-style-name">${escapeHtml(preset.name)}</div>
            <div class="ss-style-tags">${tags}</div>
            <div class="ss-style-prompt" title="${escapeHtml(prompt)}">${escapeHtml(prompt.slice(0, 120))}</div>
            ${preset.uc ? `<div class="ss-style-prompt" style="opacity:.45">UC · ${escapeHtml(String(preset.uc).slice(0, 60))}</div>` : ''}
        </div>
        <div class="ss-style-actions">
            <div class="menu_button ss-mini caution ss-charp-del">삭제</div>
            <div class="menu_button ss-mini ss-charp-edit">편집</div>
            <div class="menu_button ss-mini ss-charp-dup">복제</div>
            <div class="menu_button ss-mini ss-charp-use" title="생성 탭에 이 캐릭터를 추가합니다">추가</div>
        </div>
    </div>`;
}

function renderCharPresets($p) {
    const query = $p.find('#ss_char_search').val() ?? '';
    const tag = $p.find('#ss_char_tag_filter').val() ?? '';
    const presets = listCharPresets({ query, tag });

    const $filter = $p.find('#ss_char_tag_filter');
    const current = $filter.val();
    $filter.empty().append('<option value="">모든 태그</option>');
    for (const t of allCharPresetTags()) $filter.append(`<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`);
    $filter.val(current ?? '');

    $p.find('#ss_char_grid').html(
        presets.length
            ? presets.map(charPresetCardHtml).join('')
            : '<div class="ss-empty">저장된 캐릭터가 없습니다. 생성 탭에서 캐릭터를 만든 뒤 「현재 캐릭터 저장」을 누르세요.</div>',
    );
}

function renderVibes($p) {
    const s = getState();
    const $list = $p.find('#ss_vibe_list').empty();

    if (s.vibes.length === 0) {
        $list.html('<div class="ss-empty">바이브 이미지가 없습니다.</div>');
        return;
    }

    s.vibes.forEach((vibe, index) => {
        $list.append(`
            <div class="ss-vibe" data-index="${index}">
                <img src="${vibe.thumb || dataUrl(vibe.base64)}" alt="">
                <div class="ss-vibe-controls">
                    <label class="ss-checkline"><input type="checkbox" class="ss-vibe-enabled" ${vibe.enabled !== false ? 'checked' : ''}> 사용</label>
                    <label>Strength <input type="range" class="ss-vibe-strength" min="0" max="1" step="0.05" value="${vibe.strength ?? 0.6}"><span>${Number(vibe.strength ?? 0.6).toFixed(2)}</span></label>
                    <label>Info <input type="range" class="ss-vibe-info" min="0" max="1" step="0.05" value="${vibe.infoExtracted ?? 1}"><span>${Number(vibe.infoExtracted ?? 1).toFixed(2)}</span></label>
                </div>
                <span class="ss-linkbtn ss-vibe-remove"><i class="fa-solid fa-trash"></i></span>
            </div>
        `);
    });
}

/**
 * 전체용 + 캐릭터별 레퍼런스를 한 목록으로 그린다.
 * (캐릭터 카드에 흩어져 있으면 모바일에서 카드가 너무 길어진다)
 */
function refTargets() {
    const s = getState();
    return [
        { key: 'global', label: '그림 전체', hint: '화풍·분위기 전체에 적용', ref: s.ref },
        ...s.characters.map((character, index) => ({
            key: String(index),
            label: character.name?.trim() || `캐릭터 ${index + 1}`,
            hint: character.prompt?.trim().slice(0, 40) || '태그 없음',
            ref: character.ref,
        })),
    ];
}

function refSlotHtml(target) {
    const ref = target.ref ?? {};
    const isGlobal = target.key === 'global';
    const has = !!ref.base64;

    return `<div class="ss-refslot ${has ? 'has-image' : ''}" data-target="${target.key}">
        <div class="ss-refslot-pic" title="${has ? '눌러서 다른 이미지로 교체' : '눌러서 이미지 선택'}">
            ${has ? `<img src="${ref.thumb || dataUrl(ref.base64)}" alt="">` : '<i class="fa-solid fa-plus"></i>'}
        </div>
        <div class="ss-refslot-body">
            <div class="ss-refslot-head">
                <b>${isGlobal ? '<i class="fa-solid fa-image"></i> ' : '<i class="fa-solid fa-user"></i> '}${escapeHtml(target.label)}</b>
                ${has ? `<label class="ss-checkline"><input type="checkbox" class="ss-refslot-enabled" ${ref.enabled !== false ? 'checked' : ''}> 사용</label>` : ''}
                ${has ? '<span class="ss-linkbtn ss-refslot-clear" title="비우기"><i class="fa-solid fa-trash"></i></span>' : ''}
            </div>
            <div class="ss-refslot-hint">${escapeHtml(target.hint)}</div>
            ${has ? `
                <div class="ss-refslot-controls">
                    ${isGlobal ? `
                        <label>모드
                            <select class="text_pole ss-refslot-mode">
                                <option value="character&style"${ref.mode === 'character&style' || !ref.mode ? ' selected' : ''}>캐릭터+화풍</option>
                                <option value="character"${ref.mode === 'character' ? ' selected' : ''}>캐릭터</option>
                                <option value="style"${ref.mode === 'style' ? ' selected' : ''}>화풍</option>
                            </select>
                        </label>` : ''}
                    <label>강도 <input type="range" class="ss-refslot-strength" min="0" max="1" step="0.05" value="${ref.strength ?? 1}"><span>${Number(ref.strength ?? 1).toFixed(2)}</span></label>
                    <label>유지 <input type="range" class="ss-refslot-fidelity" min="0" max="1" step="0.05" value="${ref.fidelity ?? 1}"><span>${Number(ref.fidelity ?? 1).toFixed(2)}</span></label>
                </div>` : ''}
        </div>
    </div>`;
}

function renderReferences($p) {
    const targets = refTargets();
    $p.find('#ss_ref_list').html(targets.map(refSlotHtml).join(''));

    const used = targets.filter(t => t.ref?.base64 && t.ref.enabled !== false).length;
    $p.find('#ss_ref_total')
        .text(used ? `${used}장 사용 중${used > MAX_DIRECTOR_REFERENCES ? ` — ${MAX_DIRECTOR_REFERENCES}장 초과분 제외` : ''}` : '등록된 레퍼런스 없음')
        .toggleClass('ss-warn', used > MAX_DIRECTOR_REFERENCES);

    updateReferenceSummary($p);
}

/** 슬롯 키(global | 인덱스) → 실제 ref 객체를 읽고 쓰는 자리 */
function refHolder(key) {
    const s = getState();
    if (key === 'global') return { get: () => s.ref, set: (v) => { s.ref = v; } };

    const character = s.characters[Number(key)];
    if (!character) return null;
    return { get: () => character.ref, set: (v) => { character.ref = v; } };
}

/** 상단 대형 뷰어 (NAI 브라우저처럼 결과를 크게 보여준다) */
function renderStage($p) {
    viewerIndex = Math.min(Math.max(0, viewerIndex), Math.max(0, sessionGallery.length - 1));

    const item = sessionGallery[viewerIndex];
    const $stage = $p.find('#ss_stage');
    const $image = $p.find('#ss_stage_img');

    if (!item) {
        $stage.removeAttr('data-id');
        $image.prop('hidden', true).removeAttr('src');
        $p.find('#ss_stage_empty').prop('hidden', false);
        $p.find('#ss_stage_bar').prop('hidden', true);
        return;
    }

    // 버튼들은 stage 바깥(#ss_stage_bar)에 있으므로 양쪽 모두에 id를 달아야
    // galleryItem()의 closest('[data-id]') 가 대상을 찾는다
    $stage.attr('data-id', item.id);
    $p.find('#ss_stage_bar').attr('data-id', item.id);
    $image.attr('src', dataUrl(item.base64)).prop('hidden', false);
    $p.find('#ss_stage_empty').prop('hidden', true);
    $p.find('#ss_stage_bar').prop('hidden', false);
    $p.find('#ss_stage_prev').toggleClass('ss-disabled', viewerIndex <= 0);
    $p.find('#ss_stage_next').toggleClass('ss-disabled', viewerIndex >= sessionGallery.length - 1);

    $p.find('#ss_stage_info').html([
        `${viewerIndex + 1} / ${sessionGallery.length}`,
        item.seed ? `<b>seed</b> ${escapeHtml(item.seed)}` : '',
        item.path
            ? `<span title="${escapeHtml(item.path)}"><i class="fa-solid fa-hard-drive"></i> 저장됨</span>`
            : '<span class="ss-warn">미저장</span>',
    ].filter(Boolean).join(' · '));

    $p.find('#ss_recent .ss-recent-item').removeClass('active');
    $p.find(`#ss_recent .ss-recent-item[data-id="${item.id}"]`).addClass('active');
}

function renderGallery($p) {
    const html = sessionGallery.map(item => `
        <div class="ss-gitem" data-id="${item.id}">
            <img src="${dataUrl(item.base64)}" alt="">
            <div class="ss-gitem-bar">
                <span class="ss-gitem-seed" title="${item.path ? escapeHtml(item.path) : '아직 파일로 저장되지 않음'}">
                    ${item.path ? '<i class="fa-solid fa-hard-drive"></i> ' : ''}${escapeHtml(item.seed ?? '?')}
                </span>
                <span class="ss-linkbtn ss-g-insert" title="채팅에 삽입"><i class="fa-solid fa-comment-medical"></i></span>
                <span class="ss-linkbtn ss-g-download" title="다운로드"><i class="fa-solid fa-download"></i></span>
                <span class="ss-linkbtn ss-g-restore" title="이 설정 복원"><i class="fa-solid fa-rotate-left"></i></span>
                <span class="ss-linkbtn ss-g-seed" title="시드 재사용"><i class="fa-solid fa-seedling"></i></span>
                <span class="ss-linkbtn ss-g-style" title="그림체로 저장"><i class="fa-solid fa-palette"></i></span>
                <span class="ss-linkbtn ss-g-vibe" title="바이브로 등록"><i class="fa-solid fa-fingerprint"></i></span>
                <span class="ss-linkbtn ss-g-remove" title="목록에서 제거"><i class="fa-solid fa-xmark"></i></span>
            </div>
        </div>
    `).join('');

    const empty = '<div class="ss-empty">아직 생성한 이미지가 없습니다.</div>';
    $p.find('#ss_gallery').html(html || empty);
    $p.find('#ss_recent').html(sessionGallery.slice(0, 12).map(item => `
        <div class="ss-recent-item" data-id="${item.id}" title="${escapeHtml(item.seed ?? '')}">
            <img src="${item.thumb || dataUrl(item.base64)}" alt="">
        </div>
    `).join(''));

    renderStage($p);
}

/** 생성 바 / 설정 탭에 "어디에 저장되는지"를 항상 보여준다 */
function updateSaveHint($p) {
    const settings = getSettings();
    const folder = settings.saveFolder ?? 'NaiStudio';
    const path = `user/images/${folder}/`;

    $p.find('#ss_save_path').text(path);
    bar($p, '#ss_savehint')
        .html(settings.autoSave !== false
            ? `<i class="fa-solid fa-hard-drive"></i> ${escapeHtml(path)}`
            : '<i class="fa-solid fa-triangle-exclamation"></i> 자동 저장 꺼짐')
        .attr('title', settings.autoSave !== false
            ? `생성하면 ${path} 에 바로 저장됩니다`
            : '자동 저장이 꺼져 있어 패널을 닫으면 사라집니다')
        .toggleClass('ss-warn', settings.autoSave === false);
}

/** 지금 설정이 무료 생성 조건인지 생성 바에 표시 */
function updateAnlasChip($p) {
    const settings = getSettings();
    const { free, reasons } = checkAnlasCost(getState());
    const $chip = bar($p, '#ss_anlas');

    if (free) {
        $chip.prop('hidden', false)
            .removeClass('ss-warn')
            .html('<i class="fa-solid fa-circle-check"></i> 무료 조건')
            .attr('title', `해상도 ${FREE_TIER.MAX_PIXELS.toLocaleString()}픽셀 이하 · steps ${FREE_TIER.MAX_STEPS} 이하 · 업스케일 없음`);
        return;
    }

    $chip.prop('hidden', false)
        .addClass('ss-warn')
        .html(`<i class="fa-solid fa-coins"></i> Anlas 소모${settings.anlasGuard !== false ? ' (자동 조정됨)' : ''}`)
        .attr('title', reasons.join('\n'));
}

function updateSeedChip($p) {
    const $chip = bar($p, '#ss_lastseed');
    if (!lastSeed) return $chip.prop('hidden', true);
    $chip.prop('hidden', false).html(`<i class="fa-solid fa-seedling"></i> ${escapeHtml(lastSeed)}`);
}

async function refreshBackendStatus($p) {
    const settings = getSettings();
    const [own, autopic] = await Promise.all([pingOwnPlugin(), probeAutopicPlugin()]);

    const active = own ? 'NaiStudio 플러그인'
        : autopic === true ? 'AutoPic 플러그인'
        : 'ST 기본 (제한됨)';

    const label = settings.backend === 'auto' ? active : settings.backend;
    const degraded = !own && autopic !== true;

    $p.find('#ss_backend_status')
        .text(`백엔드: ${label}`)
        .toggleClass('ss-backend-warn', settings.backend === 'auto' && degraded);

    const lines = [
        own
            ? '✅ <b>NaiStudio 플러그인</b> 감지됨 — 캐릭터 프롬프트·바이브·레퍼런스·시드 전부 사용 가능'
            : '⬜ NaiStudio 플러그인 없음',
        autopic === true
            ? '✅ <b>AutoPic 플러그인</b> 감지됨 — 자체 플러그인이 없어도 캐릭터 프롬프트·바이브 사용 가능'
            : autopic === null
                ? '❔ AutoPic 플러그인 확인 불가 (구버전이면 탐지되지 않습니다. 설정에서 백엔드를 <b>AutoPic</b>으로 직접 고정하면 그대로 사용됩니다)'
                : '⬜ AutoPic 플러그인 없음',
    ];

    if (!own) {
        lines.push('설치하려면 <code>plugins/naistudio/</code> 에 server-plugin 내용을 복사하고 config.yaml 의 <code>enableServerPlugins: true</code>');
    }

    $p.find('#ss_backend_detail').html(lines.join('<br>'));
    renderCharacters($p);
}

/* ══════════════════════════ 이벤트 바인딩 ══════════════════════════ */

function bindPanel($p) {
    /* 탭 */
    $p.on('click', '.ss-tab', function () {
        const tab = $(this).data('tab');
        $p.find('.ss-tab').removeClass('active');
        $(this).addClass('active');
        $p.find('.ss-page').removeClass('active');
        $p.find(`.ss-page[data-page="${tab}"]`).addClass('active');
    });

    /* 접기 / 펼치기 */
    $p.on('click', '.ss-collapse-head', function () {
        const $box = $(this).closest('[data-collapse]');
        const key = $box.data('collapse');
        const collapsed = !$box.hasClass('ss-collapsed');

        $box.toggleClass('ss-collapsed', collapsed);

        const settings = getSettings();
        settings.collapsed = settings.collapsed ?? {};
        settings.collapsed[key] = collapsed;
        save();

        updateCollapsedSummaries($p);
    });

    /* 폼 → 상태 즉시 반영 */
    $p.on('change input', Object.values(FIELD_MAP).concat(Object.values(CHECK_MAP)).join(','), () => {
        readUiToState($p);
        updateAnlasChip($p);
    });

    $p.on('change', '#ss_size', function () {
        const value = String($(this).val() ?? '');
        if (!value) return;
        const [width, height] = value.split('x').map(Number);
        $p.find('#ss_width').val(width);
        $p.find('#ss_height').val(height);
        readUiToState($p);
    });

    $p.on('change', '#ss_uc_preset', function () {
        const name = $(this).val();
        if (!name) return;
        const preset = getSettings().ucPresets?.[name];
        if (preset === undefined) return;
        $p.find('#ss_negative').val(preset);
        readUiToState($p);
        $(this).val('');
    });

    /* 프롬프트 도구 */
    $p.on('click', '#ss_prompt_normalize', () => {
        $p.find('#ss_prompt').val(normalizeTags($p.find('#ss_prompt').val()));
        $p.find('#ss_negative').val(normalizeTags($p.find('#ss_negative').val()));
        readUiToState($p);
        toast('success', '태그를 정리했습니다.');
    });

    /* 가중치 조절 + 단축키 */
    $p.on('keydown', 'textarea', function (event) {
        if (event.ctrlKey && event.key === 'Enter') {
            event.preventDefault();
            bar($p, '#ss_generate').trigger('click');
            return;
        }
        if (!event.ctrlKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;

        event.preventDefault();
        const element = this;
        const value = element.value;
        const hasSelection = element.selectionStart !== element.selectionEnd;
        const range = hasSelection
            ? { start: element.selectionStart, end: element.selectionEnd, text: value.slice(element.selectionStart, element.selectionEnd) }
            : getTagRangeAtCaret(value, element.selectionStart);
        if (!range.text.trim()) return;

        const replaced = adjustWeight(range.text, event.key === 'ArrowUp' ? 0.1 : -0.1, isV4Model(getState().model));
        element.value = value.slice(0, range.start) + replaced + value.slice(range.end);
        element.selectionStart = range.start;
        element.selectionEnd = range.start + replaced.length;
        readUiToState($p);
        syncCharacterFromDom($p);
    });

    /* 태그 자동완성 */
    bindAutocomplete($p);

    /* 캐릭터 */
    $p.on('click', '#ss_char_add', () => {
        const s = getState();
        s.characters.push({ name: '', prompt: '', uc: '', center: defaultCenter(s.characters.length, s.characters.length + 1), enabled: true });
        renderCharacters($p);
    });

    $p.on('input change', '.ss-char textarea, .ss-char input', () => syncCharacterFromDom($p));

    // 위치 격자 (NAI와 동일한 5×5)
    $p.on('click', '.ss-grid-cell', function () {
        const $cell = $(this);
        const $card = $cell.closest('.ss-char');
        const character = getState().characters[Number($card.data('index'))];
        if (!character) return;

        character.center = { x: Number($cell.data('x')), y: Number($cell.data('y')) };
        $card.find('.ss-grid-cell').removeClass('active');
        $cell.addClass('active');
        $card.find('.ss-char-pos-value').text(`${character.center.x.toFixed(1)} , ${character.center.y.toFixed(1)}`);
        persistState();
    });

    // 카드 하나만 캐릭터 프리셋으로 저장 (이미 프리셋에서 온 것이면 덮어쓴다)
    $p.on('click', '.ss-char-save', function () {
        syncCharacterFromDom($p);
        const character = getState().characters[Number($(this).closest('.ss-char').data('index'))];

        if (!character || !String(character.prompt ?? '').trim()) {
            return toast('warning', '태그가 비어 있어 저장할 수 없습니다.');
        }

        const saved = upsertCharPreset({
            id: character.presetId,
            name: character.name?.trim() || character.prompt.trim().slice(0, 20),
            prompt: character.prompt ?? '',
            uc: character.uc ?? '',
            ref: character.ref ? structuredClone(character.ref) : null,
            thumb: character.ref?.thumb ?? '',
        });

        character.presetId = saved.id;
        renderCharPresets($p);
        persistState();
        toast('success', `"${saved.name}" 저장 완료`);
    });

    $p.on('click', '.ss-char-remove', function () {
        const index = Number($(this).closest('.ss-char').data('index'));
        getState().characters.splice(index, 1);
        renderCharacters($p);
    });

    $p.on('click', '.ss-char-up, .ss-char-down', function () {
        const index = Number($(this).closest('.ss-char').data('index'));
        const target = $(this).hasClass('ss-char-up') ? index - 1 : index + 1;
        const characters = getState().characters;
        if (target < 0 || target >= characters.length) return;
        [characters[index], characters[target]] = [characters[target], characters[index]];
        renderCharacters($p);
    });

    /* 시드 */
    $p.on('click', '#ss_seed_lock', () => {
        if (!lastSeed) return toast('info', '아직 고정할 시드가 없습니다.');
        $p.find('#ss_seed').val(lastSeed);
        readUiToState($p);
        toast('success', `시드 ${lastSeed} 고정`);
    });
    $p.on('click', '#ss_seed_random', () => {
        $p.find('#ss_seed').val(RANDOM_SEED);
        readUiToState($p);
        toast('info', '시드를 랜덤(-1)으로 되돌렸습니다.');
    });

    /* 생성 — 생성 바는 팝업 컨트롤 줄로 이동하므로 바 자체에 위임하고,
       패널에서 바를 되찾을 수 있도록 참조를 물려둔다 */
    const $barElement = $p.find('.ss-actionbar');
    $p.data('ssBar', $barElement);

    $barElement.on('click', '#ss_generate', () => runGenerate($p));

    $p.on('click', '#ss_save_as_style', () => openStyleEditor($p, styleFromCurrentState()));

    /* 메타데이터 드롭 */
    bindDropzone($p);

    /* 그림체 목록 */
    $p.on('input change', '#ss_style_search, #ss_style_tag_filter, #ss_style_fav_only', () => renderStyleGrid($p));
    $p.on('click', '#ss_style_new', () => openStyleEditor($p, null));

    /* ── 그림체 / 캐릭터 전환 ── */
    $p.on('click', '.ss-seg-btn', function () {
        const lib = $(this).data('lib');
        $p.find('.ss-seg-btn').removeClass('active');
        $(this).addClass('active');
        $p.find('.ss-lib').each(function () {
            $(this).prop('hidden', $(this).data('lib') !== lib);
        });
    });

    /* ── 캐릭터 프리셋 ── */
    $p.on('input change', '#ss_char_search, #ss_char_tag_filter', () => renderCharPresets($p));

    $p.on('click', '#ss_charp_new', () => openCharPresetEditor($p, null));

    $p.on('click', '#ss_charp_from_panel', async () => {
        syncCharacterFromDom($p);
        const characters = getState().characters.filter(c => String(c.prompt ?? '').trim());

        if (characters.length === 0) {
            return toast('info', '생성 탭에 저장할 캐릭터가 없습니다.');
        }

        // 한 명이면 바로, 여럿이면 고르게 한다
        let picked = characters;
        if (characters.length > 1) {
            const $list = $(`<div class="ss-picker-list">${characters.map((c, i) =>
                `<label class="ss-picker-row"><input type="checkbox" checked data-index="${i}">
                    ${escapeHtml(c.name?.trim() || c.prompt.trim().slice(0, 30))}</label>`).join('')}</div>`);

            const confirmed = await callGenericPopup($list, POPUP_TYPE.CONFIRM, '', { okButton: '저장' });
            if (!confirmed) return;

            const checked = $list.find('input:checked').map((_, el) => Number($(el).data('index'))).get();
            picked = characters.filter((_, i) => checked.includes(i));
        }

        for (const character of picked) {
            upsertCharPreset({
                name: character.name?.trim() || character.prompt.trim().slice(0, 20),
                prompt: character.prompt ?? '',
                uc: character.uc ?? '',
                ref: character.ref ? structuredClone(character.ref) : null,
                thumb: character.ref?.thumb ?? '',
            });
        }

        renderCharPresets($p);
        toast('success', `${picked.length}명을 캐릭터로 저장했습니다.`);
    });

    $p.on('click', '.ss-charp-use', function () {
        useCharPreset($p, getCharPreset($(this).closest('.ss-char-card').data('id')));
    });
    $p.on('click', '.ss-charp-edit', function () {
        openCharPresetEditor($p, getCharPreset($(this).closest('.ss-char-card').data('id')));
    });
    $p.on('click', '.ss-charp-dup', function () {
        duplicateCharPreset($(this).closest('.ss-char-card').data('id'));
        renderCharPresets($p);
    });
    $p.on('click', '.ss-charp-del', async function () {
        const id = $(this).closest('.ss-char-card').data('id');
        const preset = getCharPreset(id);
        const confirmed = await callGenericPopup(`"${escapeHtml(preset?.name ?? '')}" 캐릭터를 삭제할까요?`, POPUP_TYPE.CONFIRM);
        if (!confirmed) return;
        deleteCharPreset(id);
        renderCharPresets($p);
    });
    $p.on('click', '.ss-charp-fav', function (event) {
        event.stopPropagation();
        const id = $(this).closest('.ss-char-card').data('id');
        const preset = getCharPreset(id);
        if (!preset) return;
        upsertCharPreset({ id, favorite: !preset.favorite });
        renderCharPresets($p);
    });

    /* 생성 탭에서 저장된 캐릭터 불러오기 */
    $p.on('click', '#ss_char_from_preset', async () => {
        const presets = listCharPresets();
        if (presets.length === 0) {
            return toast('info', '저장된 캐릭터가 없습니다. 그림체 탭 → 캐릭터에서 먼저 저장하세요.');
        }

        const $list = $(`<div class="ss-picker-list">${presets.map(preset =>
            `<label class="ss-picker-row"><input type="checkbox" data-id="${preset.id}">
                <b>${escapeHtml(preset.name)}</b>
                <span class="ss-picker-sub">${escapeHtml(String(preset.prompt ?? '').slice(0, 50))}</span>
            </label>`).join('')}</div>`);

        const confirmed = await callGenericPopup($list, POPUP_TYPE.CONFIRM, '', { okButton: '추가', wide: true });
        if (!confirmed) return;

        const ids = $list.find('input:checked').map((_, el) => String($(el).data('id'))).get();
        for (const id of ids) useCharPreset($p, getCharPreset(id), { silent: true });

        if (ids.length) toast('success', `캐릭터 ${ids.length}명을 추가했습니다.`);
    });


    // 이미지 → 메타데이터 → 그림체 편집기 (그림체 탭에서 바로)
    $p.on('click', '#ss_style_from_image', () => openFilePicker($p, $p.find('#ss_style_image_input')));
    $p.on('change', '#ss_style_image_input', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;

        const loaded = await handleMetadataFile($p, file, { silent: true });
        if (!loaded) return;

        // 메타데이터가 없으면 빈 편집기를 띄우지 않고 여기서 끝낸다
        if (!loaded.meta.found) {
            toast('warning', metadataFailureReason(loaded.meta, file), '메타데이터 없음');
            return;
        }

        const meta = loaded.meta;
        openStyleEditor($p, {
            name: file.name.replace(/\.[^.]+$/, ''),
            positive: meta.prompt ?? '',
            negative: meta.negative ?? '',
            params: metaToParams(meta),
            characters: meta.characters ?? [],
            thumb: loaded.thumb,
        });
    });
    $p.on('click', '#ss_style_export', () => downloadText(exportAll(), 'naistudio-library.json'));
    $p.on('click', '#ss_style_import', () => openFilePicker($p, $p.find('#ss_style_import_input')));
    $p.on('change', '#ss_style_import_input', async function () {
        const file = this.files?.[0];
        if (!file) return;
        try {
            const result = importAll(await file.text());
            toast('success', `그림체 ${result.styles}개 · 캐릭터 ${result.charPresets}개를 가져왔습니다.`);
            renderStyleGrid($p);
            renderCharPresets($p);
        } catch (error) {
            toast('error', `가져오기 실패: ${error.message}`);
        }
        this.value = '';
    });

    // 적용된 그림체 해제 — 그 그림체가 넣었던 태그만 프롬프트에서 뺀다
    $p.on('click', '.ss-applied-clear', () => {
        const s = getState();
        if (!s.appliedStyle) return;
        s.prompt = subtractPrompt(s.prompt, s.appliedStyle.positive ?? '');
        s.negative = subtractPrompt(s.negative, s.appliedStyle.negative ?? '');
        const name = s.appliedStyle.name;
        s.appliedStyle = null;
        syncUiFromState($p);
        persistState();
        toast('info', `"${name}" 그림체를 해제했습니다.`);
    });

    $p.on('click', '#ss_style_import_st', () => importSillyTavernStyles($p));

    $p.on('click', '.ss-style-apply', function () {
        applyStyle($p, getStyle($(this).closest('.ss-style-card').data('id')), 'all');
    });
    $p.on('click', '.ss-style-edit', function () {
        openStyleEditor($p, getStyle($(this).closest('.ss-style-card').data('id')));
    });
    $p.on('click', '.ss-style-dup', function () {
        duplicateStyle($(this).closest('.ss-style-card').data('id'));
        renderStyleGrid($p);
    });
    $p.on('click', '.ss-style-del', async function () {
        const id = $(this).closest('.ss-style-card').data('id');
        const style = getStyle(id);
        const confirmed = await callGenericPopup(`"${escapeHtml(style?.name ?? '')}" 그림체를 삭제할까요?`, POPUP_TYPE.CONFIRM);
        if (!confirmed) return;
        deleteStyle(id);
        renderStyleGrid($p);
    });
    $p.on('click', '.ss-style-fav', function (event) {
        event.stopPropagation();
        const id = $(this).closest('.ss-style-card').data('id');
        const style = getStyle(id);
        if (!style) return;
        upsertStyle({ id, favorite: !style.favorite });
        renderStyleGrid($p);
    });

    /* 바이브 / 레퍼런스 */
    $p.on('click', '#ss_vibe_add', () => openFilePicker($p, $p.find('#ss_vibe_input')));
    $p.on('change', '#ss_vibe_input', async function () {
        for (const file of this.files ?? []) {
            const info = await fileToImageInfo(file);
            getState().vibes.push({ ...info, strength: 0.6, infoExtracted: 1.0, enabled: true });
        }
        this.value = '';
        getState().vibeEnabled = true;
        $p.find('#ss_vibe_enabled').prop('checked', true);
        renderVibes($p);
        persistState();
    });
    $p.on('input change', '.ss-vibe input', function () {
        const $vibe = $(this).closest('.ss-vibe');
        const index = Number($vibe.data('index'));
        const vibe = getState().vibes[index];
        if (!vibe) return;
        vibe.enabled = $vibe.find('.ss-vibe-enabled').is(':checked');
        vibe.strength = Number($vibe.find('.ss-vibe-strength').val());
        vibe.infoExtracted = Number($vibe.find('.ss-vibe-info').val());
        $vibe.find('.ss-vibe-strength').next('span').text(vibe.strength.toFixed(2));
        $vibe.find('.ss-vibe-info').next('span').text(vibe.infoExtracted.toFixed(2));
    });
    $p.on('click', '.ss-vibe-remove', function () {
        getState().vibes.splice(Number($(this).closest('.ss-vibe').data('index')), 1);
        renderVibes($p);
        persistState();
    });

    /* 레퍼런스 (전체 + 캐릭터별을 한 목록에서) */
    let pendingRefTarget = null;

    $p.on('click', '.ss-refslot-pic', function () {
        pendingRefTarget = $(this).closest('.ss-refslot').data('target');
        openFilePicker($p, $p.find('#ss_ref_input'));
    });

    $p.on('change', '#ss_ref_input', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file || pendingRefTarget === null) return;

        const holder = refHolder(String(pendingRefTarget));
        if (!holder) return;

        const info = await fileToImageInfo(file);
        const previous = holder.get() ?? {};
        holder.set({
            ...info,
            strength: previous.strength ?? 1.0,
            fidelity: previous.fidelity ?? 1.0,
            mode: previous.mode ?? (pendingRefTarget === 'global' ? 'character&style' : 'character'),
            enabled: true,
        });

        pendingRefTarget = null;
        renderReferences($p);
        renderCharacters($p);
        persistState();
        toast('success', '레퍼런스를 등록했습니다.');
    });

    $p.on('click', '.ss-refslot-clear', function () {
        const key = String($(this).closest('.ss-refslot').data('target'));
        const holder = refHolder(key);
        if (!holder) return;

        holder.set(key === 'global'
            ? { enabled: false, base64: '', thumb: '', strength: 1.0, fidelity: 1.0, mode: 'character&style' }
            : null);

        renderReferences($p);
        renderCharacters($p);
        persistState();
    });

    $p.on('input change', '.ss-refslot input, .ss-refslot select', function () {
        const $slot = $(this).closest('.ss-refslot');
        const holder = refHolder(String($slot.data('target')));
        const ref = holder?.get();
        if (!ref) return;

        ref.enabled = $slot.find('.ss-refslot-enabled').is(':checked');
        ref.strength = Number($slot.find('.ss-refslot-strength').val());
        ref.fidelity = Number($slot.find('.ss-refslot-fidelity').val());
        const mode = $slot.find('.ss-refslot-mode').val();
        if (mode) ref.mode = mode;

        $slot.find('.ss-refslot-strength').next('span').text(ref.strength.toFixed(2));
        $slot.find('.ss-refslot-fidelity').next('span').text(ref.fidelity.toFixed(2));
        $p.find('#ss_ref_total').text('');
        renderReferences($p);
    });

    /* 뷰어 + 갤러리 */
    bindStage($p);
    bindGallery($p);

    /* 설정 */
    $p.on('change', '#ss_backend_select', function () {
        getSettings().backend = String($(this).val());
        save();
        refreshBackendStatus($p);
    });
    $p.on('click', '#ss_backend_recheck', () => {
        resetBackendAvailability();
        refreshBackendStatus($p);
    });
    $p.on('change', '#ss_auto_normalize', function () {
        getSettings().autoNormalize = $(this).is(':checked');
        save();
    });
    $p.on('change', '#ss_anlas_guard', function () {
        getSettings().anlasGuard = $(this).is(':checked');
        save();
        updateAnlasChip($p);
    });
    $p.on('change', '#ss_keep_history', function () {
        getSettings().keepHistory = Number($(this).val()) || 40;
        save();
    });
    $p.on('change', '#ss_auto_save', function () {
        getSettings().autoSave = $(this).is(':checked');
        save();
        updateSaveHint($p);
    });
    $p.on('change', '#ss_save_folder', function () {
        const folder = String($(this).val() ?? '').trim().replace(/[\\/:*?"<>|]/g, '') || 'NaiStudio';
        getSettings().saveFolder = folder;
        $(this).val(folder);
        save();
        updateSaveHint($p);
    });
    $p.on('click', '#ss_save_defaults', () => {
        const s = readUiToState($p);
        const defaults = {};
        for (const key of Object.keys(DEFAULT_PARAMS)) defaults[key] = s[key];
        getSettings().defaults = defaults;
        save();
        toast('success', '현재 파라미터를 기본값으로 저장했습니다.');
    });
    $p.on('click', '#ss_history_clear', () => {
        clearHistory();
        toast('success', '히스토리를 비웠습니다.');
    });
    $p.on('click', '#ss_reset_all', async () => {
        const confirmed = await callGenericPopup('NaiStudio의 모든 설정과 저장된 그림체가 삭제됩니다. 계속할까요?', POPUP_TYPE.CONFIRM);
        if (!confirmed) return;
        delete extension_settings[EXTENSION_NAME];
        state = null;
        save();
        getSettings();
        syncUiFromState($p);
        toast('success', '초기화했습니다.');
    });
    $p.on('click', '#ss_gallery_clear', () => {
        sessionGallery = [];
        renderGallery($p);
    });
}

function syncCharacterFromDom($p) {
    const characters = getState().characters;
    $p.find('.ss-char').each(function () {
        const index = Number($(this).data('index'));
        const character = characters[index];
        if (!character) return;
        character.name = $(this).find('.ss-char-name').val();
        character.prompt = $(this).find('.ss-char-prompt').val();
        character.uc = $(this).find('.ss-char-uc').val();
        character.enabled = $(this).find('.ss-char-enabled').is(':checked');
        // 위치는 격자 클릭에서만 바뀐다 (여기서 건드리면 클릭 값이 덮어써진다)
    });
}

/* ══════════════════════════ 자동완성 ══════════════════════════ */

function tagPool() {
    const pool = new Set(BASE_TAGS);
    for (const style of getSettings().styles) {
        for (const tag of splitTags(style.positive)) pool.add(tag);
    }
    for (const entry of getSettings().history) {
        for (const tag of splitTags(entry.prompt)) pool.add(tag);
    }
    return [...pool];
}

function bindAutocomplete($p) {
    const $box = $p.find('#ss_autocomplete');
    let target = null;
    let items = [];
    let active = -1;

    const close = () => { $box.prop('hidden', true).empty(); items = []; active = -1; };

    const render = () => {
        $box.html(items.map((tag, index) =>
            `<div class="ss-ac-item ${index === active ? 'active' : ''}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</div>`,
        ).join(''));
    };

    const accept = (tag) => {
        if (!target) return;
        const range = getTagRangeAtCaret(target.value, target.selectionStart);
        const before = target.value.slice(0, range.start);
        const after = target.value.slice(range.end);
        const needsComma = after.trim() === '' || after.trimStart().startsWith(',') === false;
        target.value = `${before}${tag}${needsComma ? ', ' : ''}${after}`;
        const caret = before.length + tag.length + (needsComma ? 2 : 0);
        target.setSelectionRange(caret, caret);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        close();
        target.focus();
    };

    $p.on('input', '#ss_prompt, #ss_negative, .ss-char-prompt', function () {
        target = this;
        const range = getTagRangeAtCaret(this.value, this.selectionStart);
        const query = range.text.trim().toLowerCase();
        if (query.length < 2) return close();

        items = tagPool()
            .filter(tag => tag.toLowerCase().includes(query) && tag.toLowerCase() !== query)
            .sort((a, b) => a.toLowerCase().indexOf(query) - b.toLowerCase().indexOf(query) || a.length - b.length)
            .slice(0, 8);

        if (items.length === 0) return close();

        const rect = this.getBoundingClientRect();
        $box.css({ left: `${rect.left}px`, top: `${rect.bottom + 2}px`, width: `${Math.min(360, rect.width)}px` })
            .prop('hidden', false);
        active = -1;
        render();
    });

    $p.on('keydown', '#ss_prompt, #ss_negative, .ss-char-prompt', function (event) {
        if ($box.prop('hidden')) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            active = (active + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
            render();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            if (active < 0) return;
            event.preventDefault();
            accept(items[active]);
        } else if (event.key === 'Escape') {
            close();
        }
    });

    $p.on('mousedown', '.ss-ac-item', function (event) {
        event.preventDefault();
        accept($(this).data('tag'));
    });

    $p.on('blur', '#ss_prompt, #ss_negative, .ss-char-prompt', () => setTimeout(close, 150));
}

/* ══════════════════════════ 메타데이터 입력 ══════════════════════════ */

let lastMetadata = null;

function bindDropzone($p) {
    const $zone = $p.find('#ss_dropzone');

    $zone.on('dragover', (event) => {
        event.preventDefault();
        $zone.addClass('dragging');
    });
    $zone.on('dragleave drop', () => $zone.removeClass('dragging'));

    $zone.on('drop', async (event) => {
        event.preventDefault();
        const file = event.originalEvent.dataTransfer?.files?.[0];
        if (file) await handleMetadataFile($p, file);
    });

    $p.on('click', '#ss_dropzone_browse', () => openFilePicker($p, $p.find('#ss_dropzone_input')));
    $p.on('change', '#ss_dropzone_input', async function () {
        const file = this.files?.[0];
        if (file) await handleMetadataFile($p, file);
        this.value = '';
    });

    $p.on('paste', async (event) => {
        const item = [...(event.originalEvent.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
        if (!item) return;
        await handleMetadataFile($p, item.getAsFile());
    });

    $p.on('click', '#ss_meta_close', () => {
        $p.find('#ss_meta_result').prop('hidden', true);
        $p.find('#ss_meta_thumb').removeAttr('src');
        $p.find('#ss_meta_summary').empty();
        lastMetadata = null;
    });
    $p.on('click', '#ss_meta_apply_all', () => applyMetadata($p, 'all'));

    $p.on('click', '#ss_meta_as_charref', async () => {
        if (!lastMetadata) return;

        const characters = getState().characters;
        let index = characters.length === 0 ? -1 : 0;

        if (characters.length > 1) {
            const $picker = $(`<div class="ss-picker-list">${characters.map((c, i) =>
                `<div class="ss-picker-row" data-index="${i}">${i + 1}. ${escapeHtml(c.name || c.prompt.slice(0, 30) || `캐릭터 ${i + 1}`)}</div>`,
            ).join('')}<div class="ss-picker-row" data-index="-1">+ 새 캐릭터로 추가</div></div>`);

            let picked = null;
            $picker.on('click', '.ss-picker-row', function () {
                picked = Number($(this).data('index'));
                $picker.find('.ss-picker-row').removeClass('selected');
                $(this).addClass('selected');
            });

            const confirmed = await callGenericPopup($picker, POPUP_TYPE.CONFIRM, '', { okButton: '붙이기' });
            if (!confirmed || picked === null) return;
            index = picked;
        }

        const ref = {
            base64: lastMetadata.base64,
            thumb: lastMetadata.thumb,
            strength: 1.0,
            fidelity: 1.0,
            mode: 'character',
            enabled: true,
        };

        if (index < 0 || !characters[index]) {
            characters.push({
                name: '',
                prompt: lastMetadata.meta?.characters?.[0]?.prompt ?? '',
                uc: '',
                center: defaultCenter(characters.length, characters.length + 1),
                enabled: true,
                ref,
            });
        } else {
            characters[index].ref = ref;
        }

        renderCharacters($p);
        persistState();
        toast('success', '캐릭터 레퍼런스로 붙였습니다.');
    });
    $p.on('click', '#ss_meta_save_style', async () => {
        if (!lastMetadata) return;
        const meta = lastMetadata.meta;
        openStyleEditor($p, {
            name: '',
            positive: meta.prompt,
            negative: meta.negative,
            params: metaToParams(meta),
            characters: meta.characters ?? [],
            thumb: lastMetadata.thumb,
        });
    });
    $p.on('click', '#ss_meta_as_vibe', () => {
        if (!lastMetadata) return;
        getState().vibes.push({
            base64: lastMetadata.base64,
            thumb: lastMetadata.thumb,
            strength: 0.6,
            infoExtracted: 1.0,
            enabled: true,
        });
        getState().vibeEnabled = true;
        renderVibes($p);
        persistState();
        toast('success', '바이브 이미지로 등록했습니다.');
    });
}

function metaToParams(meta) {
    const params = {};
    for (const key of ['model', 'width', 'height', 'steps', 'scale', 'cfg_rescale', 'sampler', 'scheduler', 'sm', 'sm_dyn', 'variety_boost', 'decrisper']) {
        if (meta[key] !== undefined && meta[key] !== '') params[key] = meta[key];
    }
    return params;
}

async function handleMetadataFile($p, file, { silent = false } = {}) {
    if (!file) return null;

    try {
        const meta = await extractImageMetadata(file);
        const base64 = await blobToBase64(file);
        const thumb = await makeThumbnail(base64, 256).catch(() => '');
        lastMetadata = { meta, base64, thumb, name: file.name };

        const summary = meta.found
            ? [
                `<b>${meta.kind === 'novelai' ? 'NovelAI' : meta.kind.toUpperCase()}</b> 메타데이터를 읽었습니다.`,
                meta.model ? `모델 <code>${escapeHtml(meta.model)}</code>` : '',
                meta.width ? `${meta.width}×${meta.height}` : '',
                meta.steps ? `steps ${meta.steps}` : '',
                meta.scale !== undefined ? `scale ${meta.scale}` : '',
                meta.seed ? `seed ${escapeHtml(meta.seed)}` : '',
                meta.characters?.length ? `캐릭터 ${meta.characters.length}명` : '',
              ].filter(Boolean).join(' · ')
            : metadataFailureSummary(meta, file);

        $p.find('#ss_meta_thumb').attr('src', thumb || dataUrl(base64));
        $p.find('#ss_meta_summary').html(summary);
        $p.find('#ss_meta_result').prop('hidden', silent);

        return lastMetadata;
    } catch (error) {
        console.error('[NaiStudio] 메타데이터 읽기 실패:', error);
        toast('error', `메타데이터 읽기 실패: ${error.message}`);
        return null;
    }
}

/** 못 읽은 이유를 한 문장으로 (토스트용) */
function metadataFailureReason(meta, file) {
    const diag = meta?.diagnostics ?? {};

    if (!diag.isPng) {
        return `PNG가 아닙니다 (${diag.mime || file?.type || '?'}). 사진 앱이나 메신저를 거치며 JPEG로 바뀌면 NovelAI 정보가 사라집니다. 원본 PNG를 넣어주세요.`;
    }
    if ((diag.chunkKeys ?? []).length === 0) {
        return 'PNG 안에 남아 있는 정보가 없습니다. 편집·재저장·업로드 과정에서 지워진 이미지입니다.';
    }
    return `NovelAI/A1111 형식이 아닙니다. 찾은 항목: ${(diag.chunkKeys ?? []).join(', ')}`;
}

/** 못 읽었을 때 "왜" 못 읽었는지 알려준다 (드롭존 표시용) */
function metadataFailureSummary(meta, file) {
    return [
        '<span class="ss-warn">메타데이터를 찾지 못했습니다.</span>',
        escapeHtml(metadataFailureReason(meta, file)),
        '이미지 자체는 <b>바이브</b>나 <b>캐릭터 레퍼런스</b>로는 그대로 쓸 수 있습니다.',
    ].join('<br>');
}

function applyMetadata($p, mode) {
    if (!lastMetadata?.meta) return;
    const meta = lastMetadata.meta;
    const s = getState();

    if (mode === 'all' || mode === 'prompt') {
        s.prompt = meta.prompt ?? '';
        s.negative = meta.negative ?? '';
        s.characters = (meta.characters ?? []).map(c => ({ ...c, name: '', enabled: true }));

        // 프롬프트를 통째로 갈아끼웠으므로 이전 그림체 표시는 무효.
        // (남겨두면 다음 그림체 적용 때 엉뚱한 태그를 지우거나, 반대로 이미지 태그가 그대로 얹힌다)
        s.appliedStyle = null;
    }

    if (mode === 'all' || mode === 'params') {
        Object.assign(s, metaToParams(meta));
        if (meta.seed) s.seed = meta.seed;
    }

    syncUiFromState($p);
    persistState();
    toast('success', mode === 'prompt' ? '프롬프트를 적용했습니다.' : '메타데이터를 적용했습니다.');
}

/* ══════════════════════════ 그림체 ══════════════════════════ */

function styleFromCurrentState() {
    const s = getState();
    const params = {};
    for (const key of Object.keys(DEFAULT_PARAMS)) params[key] = s[key];

    return {
        name: '',
        positive: s.prompt,
        negative: s.negative,
        params,
        characters: structuredClone(s.characters),
        vibes: structuredClone(s.vibes),
        ref: structuredClone(s.ref),
        thumb: sessionGallery[0]?.thumb ?? '',
    };
}

/**
 * SillyTavern 기본 이미지생성 확장(sd)에 저장된 스타일을 그림체로 가져온다.
 * ST 쪽 구조: extension_settings.sd.styles = [{ name, prefix, negative }]
 * prefix 에는 보통 {prompt} 자리표시자가 들어 있다.
 */
async function importSillyTavernStyles($p) {
    const stStyles = extension_settings?.sd?.styles;

    if (!Array.isArray(stStyles) || stStyles.length === 0) {
        toast('info', 'SillyTavern 이미지생성 확장에 저장된 스타일이 없습니다.');
        return;
    }

    const existing = new Set(getSettings().styles.map(s => s.name));
    const candidates = stStyles.filter(item => item?.name && !existing.has(`[ST] ${item.name}`));

    if (candidates.length === 0) {
        toast('info', `이미 전부 가져왔습니다. (ST 스타일 ${stStyles.length}개)`);
        return;
    }

    const confirmed = await callGenericPopup(
        `SillyTavern 이미지생성 확장의 스타일 <b>${candidates.length}개</b>를 그림체로 가져올까요?<br>
         <small>${candidates.slice(0, 12).map(s => escapeHtml(s.name)).join(', ')}${candidates.length > 12 ? ' …' : ''}</small>`,
        POPUP_TYPE.CONFIRM, '', { okButton: '가져오기' },
    );
    if (!confirmed) return;

    for (const item of candidates) {
        // prefix 는 "masterpiece, {prompt}, best quality" 형태일 수 있다
        const positive = String(item.prefix ?? '')
            .split('{prompt}')
            .join(', ')
            .replace(/\s*,\s*,+/g, ',');

        upsertStyle({
            name: `[ST] ${item.name}`,
            note: 'SillyTavern 이미지생성 확장에서 가져옴',
            tags: ['ST'],
            positive: normalizeTags(positive),
            negative: normalizeTags(item.negative ?? ''),
            params: {},
            characters: [],
            vibes: [],
            ref: null,
        });
    }

    renderStyleGrid($p);
    toast('success', `${candidates.length}개를 가져왔습니다.`);
}

/** 저장된 캐릭터를 생성 탭 캐릭터 목록에 붙인다 (태그가 그대로 들어간다) */
function useCharPreset($p, preset, { silent = false } = {}) {
    if (!preset) return;

    const s = getState();
    s.characters.push({
        name: preset.name ?? '',
        prompt: preset.prompt ?? '',
        uc: preset.uc ?? '',
        center: defaultCenter(s.characters.length, s.characters.length + 1),
        enabled: true,
        ref: preset.ref ? structuredClone(preset.ref) : null,
        presetId: preset.id,
    });

    renderCharacters($p);
    renderReferences($p);
    persistState();

    if (!silent) toast('success', `"${preset.name}" 캐릭터를 추가했습니다.`);
}

async function openCharPresetEditor($p, preset) {
    const draft = preset ?? { name: '', tags: [], prompt: '', uc: '', ref: null, thumb: '' };

    const $form = $(`
        <div class="ss-editor">
            <h3>${draft.id ? '캐릭터 편집' : '새 캐릭터'}</h3>
            <label>이름<input type="text" class="text_pole ss-c-name" value="${escapeHtml(draft.name ?? '')}"></label>
            <label>분류 태그 (쉼표)<input type="text" class="text_pole ss-c-tags" value="${escapeHtml((draft.tags ?? []).join(', '))}"></label>
            <label>캐릭터 태그<textarea class="text_pole textarea_compact ss-c-prompt" rows="4" placeholder="silver hair, blue eyes, school uniform">${escapeHtml(draft.prompt ?? '')}</textarea></label>
            <label>전용 UC (선택)<textarea class="text_pole textarea_compact ss-c-uc" rows="2">${escapeHtml(draft.uc ?? '')}</textarea></label>
            <div class="ss-editor-thumb">
                ${draft.thumb ? `<img src="${draft.thumb}" alt="">` : '<div class="ss-style-nothumb"><i class="fa-solid fa-user"></i></div>'}
                <div class="menu_button ss-mini ss-c-thumb-pick">썸네일 / 레퍼런스 지정</div>
                <input type="file" class="ss-c-thumb-input ss-file-input" accept="image/*">
            </div>
            <div class="ss-hint">지정한 이미지는 썸네일이 되고, 이 캐릭터를 추가할 때 <b>캐릭터 레퍼런스</b>로도 함께 붙습니다.</div>
        </div>
    `);

    let thumb = draft.thumb ?? '';
    let ref = draft.ref ? structuredClone(draft.ref) : null;

    $form.on('click', '.ss-c-thumb-pick', () => openFilePicker($form, $form.find('.ss-c-thumb-input')));
    $form.on('change', '.ss-c-thumb-input', async function () {
        const file = this.files?.[0];
        this.value = '';
        if (!file) return;

        const info = await fileToImageInfo(file);
        thumb = info.thumb;
        ref = { ...info, strength: 1.0, fidelity: 1.0, mode: 'character', enabled: true };
        $form.find('.ss-editor-thumb img, .ss-editor-thumb .ss-style-nothumb')
            .replaceWith(`<img src="${thumb}" alt="">`);
    });

    // 팝업이 닫히며 DOM이 정리돼도 값이 남도록 미리 받아둔다
    const values = {
        name: draft.name ?? '',
        tags: (draft.tags ?? []).join(', '),
        prompt: draft.prompt ?? '',
        uc: draft.uc ?? '',
    };
    const readForm = () => {
        const pick = (selector, fallback) => {
            const $el = $form.find(selector);
            return $el.length ? $el.val() : fallback;
        };
        values.name = pick('.ss-c-name', values.name);
        values.tags = pick('.ss-c-tags', values.tags);
        values.prompt = pick('.ss-c-prompt', values.prompt);
        values.uc = pick('.ss-c-uc', values.uc);
    };
    $form.on('input change', 'input, textarea', readForm);

    const confirmed = await callGenericPopup($form, POPUP_TYPE.CONFIRM, '',
        { okButton: '저장', cancelButton: '취소', wide: true, allowVerticalScrolling: true });
    if (!confirmed) return;
    readForm();

    const saved = upsertCharPreset({
        id: draft.id,
        name: String(values.name ?? '').trim() || '이름 없는 캐릭터',
        tags: splitTags(values.tags),
        prompt: String(values.prompt ?? ''),
        uc: String(values.uc ?? ''),
        ref,
        thumb,
        favorite: draft.favorite ?? false,
    });

    renderCharPresets($p);
    toast('success', `"${saved.name}" 저장 완료`);
}

async function openStyleEditor($p, style) {
    const draft = style ?? { name: '', note: '', tags: [], positive: '', negative: '', params: {}, characters: [], vibes: [], ref: null, thumb: '' };

    /* 무엇이 같이 저장되는지 개수까지 보여준다.
       draft 에 없으면 지금 패널에 있는 것을 담는다 */
    const panel = getState();
    const draftChars = (draft.characters ?? []).filter(c => String(c?.prompt ?? '').trim());
    const panelChars = panel.characters.filter(c => String(c?.prompt ?? '').trim());
    const usingChars = draftChars.length ? draftChars : panelChars;

    const draftSources = (draft.vibes ?? []).length + (draft.ref?.base64 ? 1 : 0);
    const panelSources = panel.vibes.filter(v => v?.base64).length
        + (panel.ref?.base64 ? 1 : 0)
        + panel.characters.filter(c => c.ref?.base64).length;
    const usingSources = draftSources || panelSources;

    const hasDraftParams = Object.keys(draft.params ?? {}).length > 0;
    const params = hasDraftParams ? draft.params : styleFromCurrentState().params;

    const withParams = true;
    const withChars = usingChars.length > 0;
    const withSources = draftSources > 0;

    const paramsLabel = `${params.model ?? ''} · ${params.width}×${params.height} · ${params.steps}steps · scale ${params.scale}`;
    const charsLabel = usingChars.length
        ? `${usingChars.length}명 — ${usingChars.map(c => c.name?.trim() || c.prompt.trim().slice(0, 12)).join(', ')}`
        : '없음';
    const sourcesLabel = usingSources ? `${usingSources}장` : '없음';

    const $form = $(`
        <div class="ss-editor">
            <h3>${draft.id ? '그림체 편집' : '새 그림체'}</h3>
            <label>이름<input type="text" class="text_pole ss-e-name" value="${escapeHtml(draft.name)}"></label>
            <label>분류 태그 (쉼표)<input type="text" class="text_pole ss-e-tags" value="${escapeHtml((draft.tags ?? []).join(', '))}"></label>
            <label>메모<input type="text" class="text_pole ss-e-note" value="${escapeHtml(draft.note ?? '')}"></label>
            <label>그림체 프롬프트<textarea class="text_pole textarea_compact ss-e-positive" rows="4">${escapeHtml(draft.positive ?? '')}</textarea></label>
            <label>전용 UC<textarea class="text_pole textarea_compact ss-e-negative" rows="3">${escapeHtml(draft.negative ?? '')}</textarea></label>
            <div class="ss-editor-opts">
                <div class="ss-editor-opts-title">같이 저장할 것</div>
                <label class="ss-checkline"><input type="checkbox" class="ss-e-with-params" ${withParams ? 'checked' : ''}>
                    <span>파라미터 <small>${escapeHtml(paramsLabel)}</small></span></label>
                <label class="ss-checkline"><input type="checkbox" class="ss-e-with-chars" ${withChars ? 'checked' : ''}>
                    <span>캐릭터 프롬프트 <small>${escapeHtml(charsLabel)}</small></span></label>
                <label class="ss-checkline"><input type="checkbox" class="ss-e-with-sources" ${withSources ? 'checked' : ''}>
                    <span>레퍼런스 · 바이브 <small>${escapeHtml(sourcesLabel)}</small></span></label>
            </div>
            <div class="ss-editor-thumb">
                ${draft.thumb ? `<img src="${draft.thumb}" alt="">` : '<div class="ss-style-nothumb"><i class="fa-solid fa-palette"></i></div>'}
                <div class="menu_button ss-mini ss-e-thumb-pick">썸네일 지정</div>
                <input type="file" class="ss-e-thumb-input ss-file-input" accept="image/*">
            </div>
        </div>
    `);

    let thumb = draft.thumb ?? '';
    $form.on('click', '.ss-e-thumb-pick', () => openFilePicker($form, $form.find('.ss-e-thumb-input')));
    $form.on('change', '.ss-e-thumb-input', async function () {
        const file = this.files?.[0];
        if (!file) return;
        thumb = await makeThumbnail(await blobToBase64(file));
        $form.find('.ss-editor-thumb img, .ss-editor-thumb .ss-style-nothumb')
            .replaceWith(`<img src="${thumb}" alt="">`);
    });

    /* 입력값은 팝업이 닫히기 전에 계속 받아둔다.
       닫힌 뒤에 $form.find(...).val() 로 읽으면, ST가 팝업 내용을 정리한 경우
       undefined 가 들어가 그림체가 깨진 채로 저장된다(카드 렌더링이 죽어 버튼이 먹통이 됨). */
    const values = {
        name: draft.name ?? '',
        note: draft.note ?? '',
        tags: (draft.tags ?? []).join(', '),
        positive: draft.positive ?? '',
        negative: draft.negative ?? '',
        withParams,
        withChars,
        withSources,
    };

    const readForm = () => {
        const pick = (selector, fallback) => {
            const $el = $form.find(selector);
            return $el.length ? $el.val() : fallback;
        };
        values.name = pick('.ss-e-name', values.name);
        values.note = pick('.ss-e-note', values.note);
        values.tags = pick('.ss-e-tags', values.tags);
        values.positive = pick('.ss-e-positive', values.positive);
        values.negative = pick('.ss-e-negative', values.negative);

        const check = (selector, fallback) => {
            const $el = $form.find(selector);
            return $el.length ? $el.is(':checked') : fallback;
        };
        values.withParams = check('.ss-e-with-params', values.withParams);
        values.withChars = check('.ss-e-with-chars', values.withChars);
        values.withSources = check('.ss-e-with-sources', values.withSources);
    };

    $form.on('input change', 'input, textarea', readForm);

    const confirmed = await callGenericPopup($form, POPUP_TYPE.CONFIRM, '',
        { okButton: '저장', cancelButton: '취소', wide: true, allowVerticalScrolling: true });
    if (!confirmed) return;

    readForm();   // 아직 DOM이 살아 있으면 마지막 값까지 반영

    const current = getState();
    const saved = upsertStyle({
        id: draft.id,
        name: String(values.name ?? '').trim() || '이름 없는 그림체',
        note: String(values.note ?? ''),
        tags: splitTags(values.tags),
        positive: String(values.positive ?? ''),
        negative: String(values.negative ?? ''),
        params: values.withParams ? structuredClone(params) : {},
        characters: values.withChars ? structuredClone(usingChars) : [],
        vibes: values.withSources
            ? ((draft.vibes ?? []).length ? draft.vibes : structuredClone(current.vibes))
            : [],
        ref: values.withSources
            ? (draft.ref?.base64 ? draft.ref : structuredClone(current.ref))
            : null,
        thumb,
        favorite: draft.favorite ?? false,
    });

    renderStyleGrid($p);
    toast('success', `"${saved.name}" 저장 완료`);
}

/**
 * @param {'all'|'prompt'|'params'} mode
 */
function applyStyle($p, style, mode = 'all') {
    if (!style) return;

    readUiToState($p);   // 사용자가 방금 고친 프롬프트까지 반영한 뒤에 계산한다
    const s = getState();

    if (mode === 'all' || mode === 'prompt') {
        // 프롬프트는 항상 그림체 것으로 통째로 교체한다.
        // (이전 태그를 부분적으로 걷어내는 방식은 이미지에서 온 태그처럼
        //  '무엇이 화풍인지' 알 수 없는 경우 태그가 섞여버린다)
        s.prompt = String(style.positive ?? '');
        s.negative = String(style.negative ?? '');
        s.appliedStyle = { id: style.id, name: style.name, positive: style.positive, negative: style.negative };
    }

    if (mode === 'all' || mode === 'params') {
        Object.assign(s, style.params ?? {});
    }

    if (mode === 'all') {
        if ((style.characters ?? []).length) s.characters = structuredClone(style.characters);
        if ((style.vibes ?? []).length) {
            s.vibes = structuredClone(style.vibes);
            s.vibeEnabled = true;
        }
        if (style.ref?.base64) s.ref = structuredClone(style.ref);
    }

    syncUiFromState($p);
    persistState();
    toast('success', `"${style.name}" 적용 — 프롬프트를 교체했습니다.`);
}

/* ══════════════════════════ 생성 ══════════════════════════ */

function setBusy($p, busy, text = '') {
    isGenerating = busy;
    // 생성 버튼은 비활성화하지 않는다 — 생성 중 다시 누르면 중단이기 때문
    const $button = bar($p, '#ss_generate');
    if (!$button.length) {
        // 여기 걸리면 바 참조가 끊긴 것 — 상태 표시가 통째로 죽는다
        console.warn('[NaiStudio] 생성 바를 찾지 못해 상태 표시를 갱신하지 못했습니다.');
    }

    $button.toggleClass('ss-busy', busy);
    bar($p, '#ss_progress').prop('hidden', !busy).text(text);
}

async function runGenerate($p) {
    if (isGenerating) {
        toast('info', '이미 생성 중입니다.');
        return;
    }

    const settings = getSettings();
    const s = readUiToState($p);
    syncCharacterFromDom($p);

    if (!String(s.prompt).trim() && s.characters.length === 0) {
        return toast('warning', '프롬프트가 비어 있습니다.');
    }

    setBusy($p, true, '생성 준비 중…');

    const normalize = settings.autoNormalize !== false;
    const seedValue = Number(s.seed);
    const fixedSeed = String(s.seed).trim() !== '' && Number.isInteger(seedValue) && seedValue >= 0
        ? seedValue
        : null;   // 비었거나 -1이면 서버가 난수 생성

    // 레퍼런스(전역 + 캐릭터별)는 NAI가 허용하는 캔버스로 미리 맞춰둔다 — 매 장 반복할 필요 없음
    const preparedRef = s.ref?.enabled && s.ref?.base64
        ? { ...s.ref, base64: await letterboxReference(s.ref.base64) }
        : null;

    const preparedCharacters = [];
    for (const character of s.characters) {
        const ref = character.ref;
        preparedCharacters.push(ref?.base64 && ref.enabled !== false
            ? { ...character, ref: { ...ref, base64: await letterboxReference(ref.base64) } }
            : character);
    }

    const refCount = (preparedRef ? 1 : 0)
        + preparedCharacters.filter(c => c.enabled !== false && c.ref?.base64 && c.ref.enabled !== false).length;
    if (refCount > MAX_DIRECTOR_REFERENCES) {
        toast('warning', `레퍼런스가 ${refCount}장입니다. 앞의 ${MAX_DIRECTOR_REFERENCES}장만 전송됩니다.`);
    }

    try {
        setBusy($p, true, '생성 중…');

        {
            // Anlas 가드 — ST의 novel_anlas_guard 는 SD 확장 전용이라 여기엔 적용되지 않는다
            let guarded = s;
            if (settings.anlasGuard !== false) {
                const { state: clamped, notes } = applyAnlasGuard(s);
                guarded = clamped;
                if (notes.length > 0) {
                    toast('info', `Anlas 아끼기: ${notes.join(', ')}`);
                }
            }

            const resolved = {
                ...guarded,
                prompt: resolvePrompt(s.prompt, { normalize }),
                negative: resolvePrompt(s.negative, { normalize }),
                characters: preparedCharacters.map(c => ({ ...c, prompt: resolvePrompt(c.prompt, { normalize }) })),
                vibes: s.vibeEnabled ? s.vibes : [],
                ref: preparedRef,
                seed: fixedSeed === null ? RANDOM_SEED : fixedSeed,
            };

            const payload = buildPayload(resolved);
            const result = await generateImage(payload, { preferred: settings.backend ?? 'auto' });

            if (result.warning) toast('warning', result.warning);

            const item = {
                id: `g_${Date.now()}`,
                base64: result.image,
                seed: String(result.seed ?? resolved.seed ?? ''),
                backend: result.backend,
                snapshot: structuredClone({
                    ...resolved,
                    vibes: [],
                    ref: null,
                    characters: resolved.characters.map(c => ({ ...c, ref: null })),
                }),
                thumb: await makeThumbnail(result.image, 192).catch(() => ''),
                path: '',
            };

            // 채팅방 유무와 관계없이 항상 같은 폴더에 저장한다
            if (settings.autoSave !== false) {
                try {
                    item.path = await saveImageToServer(item.base64, `ss_${item.seed || 'img'}`, settings.saveFolder);
                } catch (error) {
                    console.warn('[NaiStudio] 자동 저장 실패:', error);
                    toast('warning', `파일 저장 실패: ${error.message}`);
                }
            }

            lastSeed = item.seed || lastSeed;
            sessionGallery.unshift(item);
            if (sessionGallery.length > 60) sessionGallery.length = 60;
            viewerIndex = 0;   // 새로 뽑은 그림을 바로 크게 보여준다

            addHistory({
                prompt: resolved.prompt,
                negative: resolved.negative,
                seed: item.seed,
                params: Object.fromEntries(Object.keys(DEFAULT_PARAMS).map(k => [k, resolved[k]])),
                characters: resolved.characters,
            });

            renderGallery($p);
            updateSeedChip($p);

            const saved = settings.autoSave !== false
                ? ` · user/images/${settings.saveFolder ?? 'NaiStudio'}/ 에 저장됨`
                : '';
            toast('success', `생성 완료 (시드 ${item.seed || '랜덤'})${saved}`);
        }
    } catch (error) {
        console.error('[NaiStudio] 생성 실패:', error);
        toast('error', error.message ?? String(error), '생성 실패');
    } finally {
        setBusy($p, false);
        persistState();
    }
}

/* ══════════════════════════ 갤러리 동작 ══════════════════════════ */

function galleryItem($el) {
    const id = $el.closest('[data-id]').data('id');
    return sessionGallery.find(item => item.id === id);
}

function downloadText(text, filename) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 브라우저 다운로드 (기기에 파일로 저장) */
function downloadImage(item) {
    if (!item) return;
    const link = document.createElement('a');
    link.href = dataUrl(item.base64);
    link.download = `naistudio_${item.seed || Date.now()}.png`;
    link.click();
    toast('success', '이미지를 저장했습니다.');
}

function bindStage($p) {
    // 이미지를 누르면 크게 보기 (저장은 아래 버튼으로)
    $p.on('click', '#ss_stage_img', () => openLightbox(sessionGallery[viewerIndex]));

    $p.on('click', '#ss_stage_prev', (event) => {
        event.stopPropagation();
        viewerIndex = Math.max(0, viewerIndex - 1);
        renderStage($p);
    });

    $p.on('click', '#ss_stage_next', (event) => {
        event.stopPropagation();
        viewerIndex = Math.min(sessionGallery.length - 1, viewerIndex + 1);
        renderStage($p);
    });

    // 썸네일을 누르면 뷰어에 띄운다
    $p.on('click', '.ss-recent-item', function () {
        const id = $(this).data('id');
        const index = sessionGallery.findIndex(item => item.id === id);
        if (index < 0) return;
        viewerIndex = index;
        renderStage($p);
    });

    // 갤러리 탭에서 누르면 뷰어로 보내고 생성 탭으로 이동
    $p.on('click', '.ss-gitem img', function () {
        const id = $(this).closest('[data-id]').data('id');
        const index = sessionGallery.findIndex(item => item.id === id);
        if (index < 0) return;
        viewerIndex = index;
        $p.find('.ss-tab[data-tab="generate"]').trigger('click');
        renderStage($p);
    });
}

function bindGallery($p) {
    $p.on('click', '.ss-g-insert', async function () {
        const item = galleryItem($(this));
        if (!item) return;

        const settings = getSettings();
        try {
            // 이미 저장돼 있으면 그 파일을 그대로 쓴다 (사본을 만들지 않는다)
            if (!item.path) {
                item.path = await saveImageToServer(item.base64, `ss_${item.seed || 'img'}`, settings.saveFolder);
                renderGallery($p);
            }

            if (!isChatOpen()) {
                toast('warning', `열려 있는 채팅이 없어 삽입은 못 했습니다. 파일은 user/images/${settings.saveFolder ?? 'NaiStudio'}/ 에 저장돼 있습니다.`);
                return;
            }

            await sendImageToChat(item.path, item.snapshot?.prompt ?? '');
            toast('success', '채팅에 삽입했습니다.');
        } catch (error) {
            toast('error', `삽입 실패: ${error.message}`);
        }
    });

    $p.on('click', '.ss-g-download', function () {
        downloadImage(galleryItem($(this)));
    });

    $p.on('click', '.ss-g-restore', function () {
        const item = galleryItem($(this));
        if (!item?.snapshot) return;
        Object.assign(getState(), structuredClone(item.snapshot));
        syncUiFromState($p);
        toast('success', '해당 이미지의 설정을 복원했습니다.');
    });

    $p.on('click', '.ss-g-seed', function () {
        const item = galleryItem($(this));
        if (!item?.seed) return toast('info', '시드 정보가 없습니다.');
        getState().seed = item.seed;
        $p.find('#ss_seed').val(item.seed);
        toast('success', `시드 ${item.seed} 적용`);
    });

    $p.on('click', '.ss-g-style', async function () {
        const item = galleryItem($(this));
        if (!item) return;
        openStyleEditor($p, {
            name: '',
            positive: item.snapshot?.prompt ?? '',
            negative: item.snapshot?.negative ?? '',
            params: Object.fromEntries(Object.keys(DEFAULT_PARAMS).map(k => [k, item.snapshot?.[k]])),
            characters: item.snapshot?.characters ?? [],
            thumb: item.thumb,
        });
    });

    $p.on('click', '.ss-g-vibe', function () {
        const item = galleryItem($(this));
        if (!item) return;
        getState().vibes.push({ base64: item.base64, thumb: item.thumb, strength: 0.6, infoExtracted: 1.0, enabled: true });
        getState().vibeEnabled = true;
        renderVibes($p);
        persistState();
        toast('success', '바이브로 등록했습니다.');
    });

    $p.on('click', '.ss-g-remove', function () {
        const item = galleryItem($(this));
        sessionGallery = sessionGallery.filter(g => g.id !== item?.id);
        renderGallery($p);
    });

}

/** 이미지를 원본 크기로 크게 보기 */
function openLightbox(item) {
    if (!item) return;

    callGenericPopup(
        `<div class="ss-lightbox">
            <img src="${dataUrl(item.base64)}">
            <div class="ss-lightbox-meta">
                <b>seed</b> ${escapeHtml(item.seed)}${item.path ? ` · <b>파일</b> ${escapeHtml(item.path)}` : ''}
                <pre>${escapeHtml(item.snapshot?.prompt ?? '')}</pre>
            </div>
        </div>`,
        POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true },
    );
}

/* ══════════════════════════ 설정 서랍 / 초기화 ══════════════════════════ */

function createSettingsDrawer() {
    if ($('#ss_settings_container').length) return;

    $('#extensions_settings2').append(`
        <div id="ss_settings_container" class="extension_container">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>NaiStudio</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="ss-drawer">
                        <div class="ss-open-btn" id="ss_open_panel" role="button" tabindex="0">
                            <i class="fa-solid fa-wand-magic-sparkles"></i>
                            <span>스튜디오 열기</span>
                        </div>
                        <div class="ss-hint" id="ss_drawer_status">백엔드 확인 중…</div>
                        <div class="ss-hint">
                            그림체 <span id="ss_drawer_count">0</span>개 ·
                            캐릭터 <span id="ss_drawer_chars">0</span>개 ·
                            <a href="#" id="ss_drawer_export">내보내기</a>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `);

    $('#ss_open_panel').on('click', openPanelFromEvent);
    $('#ss_drawer_export').on('click', (event) => {
        event.preventDefault();
        downloadText(exportAll(), 'naistudio-library.json');
    });

    updateDrawer();
}

async function updateDrawer() {
    const own = await pingOwnPlugin();
    $('#ss_drawer_count').text(getSettings().styles.length);
    $('#ss_drawer_chars').text(getSettings().charPresets.length);
    $('#ss_drawer_status').html(own
        ? '서버 플러그인 <b>연결됨</b> — 캐릭터 프롬프트/바이브 사용 가능'
        : '서버 플러그인 <b>없음</b> — AutoPic 플러그인 또는 ST 기본 경로로 폴백');
}

function addWandMenuItem() {
    if ($('#ss_wand_item').length) return;

    const $item = $(`
        <div id="ss_wand_item" class="list-group-item flex-container flexGap5" title="NaiStudio 열기">
            <div class="fa-solid fa-palette extensionsMenuExtensionButton"></div>
            <span>NaiStudio</span>
        </div>
    `);
    $item.on('click', openPanelFromEvent);

    const $menu = $('#extensionsMenu');
    if ($menu.length) $menu.append($item);
    else setTimeout(addWandMenuItem, 1000);
}

async function registerSlashCommands() {
    try {
        const [{ SlashCommand }, { SlashCommandArgument, ARGUMENT_TYPE }] = await Promise.all([
            import('../../../slash-commands/SlashCommand.js'),
            import('../../../slash-commands/SlashCommandArgument.js'),
        ]);
        const { SlashCommandParser } = await import('../../../slash-commands/SlashCommandParser.js');

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'naiopen',
            callback: () => { openPanel(); return ''; },
            helpString: 'NaiStudio 패널을 엽니다.',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'naistyle',
            callback: (_args, value) => {
                const name = String(value ?? '').trim().toLowerCase();
                const style = getSettings().styles.find(s => s.name.toLowerCase() === name);
                if (!style) return '그림체를 찾을 수 없습니다.';
                const s = getState();
                // 패널에서 적용할 때와 동일하게 프롬프트를 교체한다
                s.prompt = String(style.positive ?? '');
                s.negative = String(style.negative ?? '');
                s.appliedStyle = { id: style.id, name: style.name, positive: style.positive, negative: style.negative };
                Object.assign(s, style.params ?? {});
                persistState();
                return style.name;
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({ description: '그림체 이름', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
            ],
            helpString: '저장된 그림체를 현재 NaiStudio 상태에 적용합니다.',
        }));
    } catch (error) {
        console.debug('[NaiStudio] 슬래시 커맨드 등록 생략:', error?.message ?? error);
    }
}

/** manifest의 css 로딩이 안 된 경우를 대비한 보험 */
function ensureStyles() {
    if ($('link[href*="NaiStudio/style.css"]').length) return;
    $('head').append(`<link rel="stylesheet" href="${extensionFolderPath}/style.css">`);
}

jQuery(async () => {
    ensureStyles();
    getSettings();
    createSettingsDrawer();
    addWandMenuItem();
    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        addWandMenuItem();
        updateDrawer();
    });

    console.log('[NaiStudio] 로드 완료');
});

// 디버깅/외부 연동용
window.NaiStudio = {
    open: openPanel,
    getState,
    getSettings,
    get gallery() { return sessionGallery; },
    get busy() { return isGenerating; },
    exportLibrary: exportAll,
    getContext,
};
