figma.showUI(__html__, { width: 340, height: 490 });

// ─── 폰트 로딩 (한국어 우선) ─────────────────────────────────────
async function loadFont(style) {
    var bold = (style === 'Bold' || style === 'SemiBold');
    var kStyle = bold ? 'Bold' : 'Regular';
    var iStyle = bold ? 'Bold' : 'Regular';

    var tries = [
        { family: 'Noto Sans KR', style: kStyle },
        { family: 'Inter', style: iStyle },
        { family: 'Inter', style: 'Regular' }
    ];

    for (var i = 0; i < tries.length; i++) {
        try {
            await figma.loadFontAsync(tries[i]);
            return tries[i];
        } catch (e) { /* 다음 시도 */ }
    }
    // 최후의 수단 - Inter Regular 강제 로드
    var def = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(def);
    return def;
}

// ─── Base64 → Uint8Array ─────────────────────────────────────────
function b64ToBytes(b64) {
    var pure = b64.replace(/^data:image\/\w+;base64,/, '');
    return figma.base64Decode(pure);
}

// ─── 값 범위 제한 ─────────────────────────────────────────────────
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// ─── 색상 오브젝트 → Figma 페인트 ───────────────────────────────
function toFill(c) {
    if (!c) return null;
    return {
        type: 'SOLID',
        color: { r: clamp(c.r, 0, 1), g: clamp(c.g, 0, 1), b: clamp(c.b, 0, 1) },
        opacity: clamp(c.a !== undefined ? c.a : 1, 0, 1)
    };
}

// ─── 노드 하나를 Figma 객체로 변환 (재귀) ───────────────────────
async function convertJSONToFigma(jsonNode, parent) {
    if (!jsonNode) return;

    var w = Math.max(1, jsonNode.width || 1);
    var h = Math.max(1, jsonNode.height || 1);
    var node;

    try {

        /* ── TEXT ────────────────────────────────────────────── */
        if (jsonNode.type === 'TEXT') {
            node = figma.createText();

            var fw = parseInt(jsonNode.fontWeight) || 400;
            var fontStyle = fw >= 600 ? 'Bold' : 'Regular';
            var font = await loadFont(fontStyle);

            node.fontName = font;
            node.fontSize = Math.max(1, jsonNode.fontSize || 14);

            // 웹 환경과 동일하게 동작하도록: 좌우 폭은 컨테이너 넓이에 맞추고, 높이는 자동(HEIGHT)으로 늘어나 자연스럽게 줄바꿈(Wrap) 되도록 함
            node.resize(w, h);
            node.textAutoResize = 'HEIGHT';

            // 글자 설정
            node.characters = String(jsonNode.characters || '');

            // 색상
            var fill = toFill(jsonNode.color);
            if (fill) node.fills = [fill];

            // 정렬
            if (jsonNode.textAlign === 'center') node.textAlignHorizontal = 'CENTER';
            else if (jsonNode.textAlign === 'right') node.textAlignHorizontal = 'RIGHT';
            else node.textAlignHorizontal = 'LEFT';

            // 줄 간격
            if (jsonNode.lineHeight > 0) {
                node.lineHeight = { value: jsonNode.lineHeight, unit: 'PIXELS' };
            }

            // 수직 정렬
            if (jsonNode.textAlignVertical === 'center') {
                node.textAlignVertical = 'CENTER';
            } else if (jsonNode.textAlignVertical === 'bottom') {
                node.textAlignVertical = 'BOTTOM';
            } else {
                node.textAlignVertical = 'TOP';
            }

            /* ── SVG ─────────────────────────────────────────────── */
        } else if (jsonNode.type === 'SVG' && jsonNode.svgContent) {
            try {
                node = figma.createNodeFromSvg(jsonNode.svgContent);
            } catch (e) {
                node = figma.createFrame();
                node.fills = [];
            }
            if (node.clipsContent !== undefined) node.clipsContent = false;
            node.resize(w, h);

            /* ── SCREENSHOT (아이콘, img 등) ─────────────────────── */
        } else if (jsonNode.type === 'SCREENSHOT') {
            node = figma.createRectangle();
            if (jsonNode.base64) {
                try {
                    var bytes = b64ToBytes(jsonNode.base64);
                    var img = figma.createImage(bytes);
                    node.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
                } catch (e) {
                    // 이미지 실패 → 회색 플레이스홀더
                    node.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
                }
            } else {
                // 캡처 실패 → 연보라 플레이스홀더 (아이콘 위치 표시용)
                node.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.88, b: 1 } }];
            }
            node.resize(w, h);

            /* ── FRAME (div, section, 컨테이너) ─────────────────── */
        } else {
            node = figma.createFrame();
            node.clipsContent = jsonNode.overflowHidden || false;

            // 배경색
            var bgFill = toFill(jsonNode.fills);
            node.fills = bgFill ? [bgFill] : [];

            // 모서리 둥글기
            if (jsonNode.radius > 0) node.cornerRadius = jsonNode.radius;

            // 테두리
            if (jsonNode.border && jsonNode.border.width > 0 && jsonNode.border.color) {
                var bc = jsonNode.border.color;
                node.strokes = [{ type: 'SOLID', color: { r: bc.r, g: bc.g, b: bc.b }, opacity: bc.a }];
                node.strokeWeight = jsonNode.border.width;
                node.strokeAlign = 'INSIDE';
            }

            // 그림자 (box-shadow → Drop Shadow)
            if (jsonNode.boxShadow) {
                var bs = jsonNode.boxShadow;
                node.effects = [{
                    type: 'DROP_SHADOW',
                    color: {
                        r: clamp(bs.color.r, 0, 1),
                        g: clamp(bs.color.g, 0, 1),
                        b: clamp(bs.color.b, 0, 1),
                        a: clamp(bs.color.a, 0, 1)
                    },
                    offset: { x: bs.x, y: bs.y },
                    radius: bs.blur || 0,
                    spread: bs.spread || 0,
                    visible: true,
                    blendMode: 'NORMAL'
                }];
            }

            node.resize(w, h);
        }

        // ── 공통 속성 ──────────────────────────────────────────
        node.name = jsonNode.name || jsonNode.type || 'node';
        node.x = jsonNode.relX || 0;
        node.y = jsonNode.relY || 0;

        if (jsonNode.opacity !== undefined) {
            node.opacity = Math.max(0, Math.min(1, jsonNode.opacity));
        }

        var newEffects = node.effects ? node.effects.slice() : [];
        if (jsonNode.filter && jsonNode.filter.includes('blur')) {
            var m1 = jsonNode.filter.match(/blur\(([\d.]+)px\)/);
            if (m1 && parseFloat(m1[1]) > 0) newEffects.push({ type: 'LAYER_BLUR', radius: parseFloat(m1[1]), visible: true });
        }
        if (jsonNode.backdropFilter && jsonNode.backdropFilter.includes('blur')) {
            var m2 = jsonNode.backdropFilter.match(/blur\(([\d.]+)px\)/);
            if (m2 && parseFloat(m2[1]) > 0) newEffects.push({ type: 'BACKGROUND_BLUR', radius: parseFloat(m2[1]), visible: true });
        }
        if (newEffects.length > 0) node.effects = newEffects;

        parent.appendChild(node);

        // ── 자식 재귀 (FRAME 한정) ─────────────────────────────
        if (node.type === 'FRAME' && jsonNode.children && jsonNode.children.length > 0) {
            for (var ci = 0; ci < jsonNode.children.length; ci++) {
                await convertJSONToFigma(jsonNode.children[ci], node);
            }
        }

    } catch (err) {
        console.error('[렌더오류] ' + (jsonNode.name || '?') + ' : ' + String(err));
    }
}

// ─── 메시지 수신 ─────────────────────────────────────────────────
figma.ui.onmessage = async function (msg) {

    // ── 창 크기 조절 (탭 전환 시) ──────────────────────────────────
    if (msg.type === 'resize') {
        figma.ui.resize(msg.width, msg.height);
        return;
    }

    // ── 인터랙티브 캡처 → Figma 이미지 노드 생성 ──────────────────
    if (msg.type === 'export-captures') {
        try {
            var captures = msg.captures || [];
            if (captures.length === 0) return;

            figma.notify('캡처 이미지 생성 중... (' + captures.length + '개)');

            var frames = [];
            var offsetX = 0;
            var maxH = 100;

            var section = figma.createSection();
            section.name = '📸 스크린샷 캡처본';
            figma.currentPage.appendChild(section);

            for (var ci = 0; ci < captures.length; ci++) {
                var cap = captures[ci];
                var w = Math.max(1, cap.width || 1920);
                var h = Math.max(1, cap.height || 1080);
                if (h > maxH) maxH = h;

                var frame = figma.createFrame();
                frame.name = cap.label || ('캡처 ' + (ci + 1));
                frame.resize(w, h);
                frame.x = section.x + offsetX + 50;
                frame.y = section.y + 50;
                frame.fills = [];

                var bytes = b64ToBytes(cap.data);
                var img = figma.createImage(bytes);
                var rect = figma.createRectangle();
                rect.resize(w, h);
                rect.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }];
                frame.appendChild(rect);

                section.appendChild(frame);
                frames.push(frame);
                offsetX += w + 40;
            }

            section.resizeWithoutConstraints(Math.max(100, offsetX + 60), Math.max(100, maxH + 100));
            figma.viewport.scrollAndZoomIntoView([section]);
            figma.notify('✅ ' + captures.length + '개 캡처 Figma 생성 완료!');
            figma.ui.postMessage({ type: 'export-done' });
        } catch (err) {
            figma.notify('❌ 내보내기 오류: ' + String(err), { error: true });
        }
        return;
    }

    if (msg.type !== 'generate-screenshot') return;

    try {
        figma.notify('서버에서 데이터 가져오는 중...');

        var payload = msg.mode === 'url' ? { url: msg.value } : { html: msg.value };
        payload.clickSelectors = msg.clickSelectors || [];
        payload.actions = msg.actions || [];
        payload.viewport = msg.viewport ? { width: msg.viewport, height: 1080 } : null;
        payload.showHidden = msg.showHidden || false;

        var resp = await fetch('http://localhost:3000/api/screenshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!resp.ok) throw new Error('서버 응답 오류: ' + resp.status);

        var result = await resp.json();

        if (!result.success || !result.data) {
            figma.notify('❌ 데이터를 받지 못했습니다.', { error: true });
            return;
        }

        var tree = result.data;

        // ── 섹션(Section) 생성 및 묶기 ────────────────────────────────
        var rootW = Math.max(1, tree.width || 1920);
        var rootH = Math.max(1, tree.height || 1080);

        var section = figma.createSection();
        section.name = msg.mode === 'url' ? ('🌐 ' + msg.value) : 'DOM 변환 결과';
        section.resizeWithoutConstraints(rootW + 100, rootH + 100);
        figma.currentPage.appendChild(section);

        // 루트 프레임 생성
        var root = figma.createFrame();
        root.name = '🎨 인터랙티브 상태 기반 DOM';
        root.resize(rootW, rootH);
        root.clipsContent = false;

        root.x = section.x + 50;
        root.y = section.y + 50;

        // 본문 배경색
        var rootBg = toFill(tree.fills);
        root.fills = rootBg ? [rootBg] : [{ type: 'SOLID', color: { r: 0.965, g: 0.965, b: 0.965 } }];

        section.appendChild(root);

        figma.notify('피그마 레이어 생성 중... ✨');

        var kids = tree.children || [];
        for (var i = 0; i < kids.length; i++) {
            await convertJSONToFigma(kids[i], root);
        }

        figma.viewport.scrollAndZoomIntoView([section]);
        figma.notify('✅ 변환 완료!');

    } catch (err) {
        figma.notify('❌ 오류: ' + String(err), { error: true });
        console.error('플러그인 오류:', err);
    } finally {
        figma.ui.postMessage({ type: 'generation-done' });
    }
};
