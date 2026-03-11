const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = 3000;

app.use(cors({ origin: true, credentials: true })); // 피그마 iframe 통신을 위한 쿠키 허용
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(cookieParser());

// 어떤 노드를 "개별 스크린샷"으로 처리할지 결정하는 기준
// 텍스트만 있는 소박한 요소는 제외하고, 아이콘/이미지 관련 노드에만 적용
const SCREENSHOT_TAGS = new Set(['IMG', 'CANVAS', 'VIDEO', 'PICTURE', 'IFRAME']);

app.post('/api/screenshot', async (req, res) => {
    const { url, html, viewport, clickSelectors, showHidden } = req.body;

    if (!url && !html) {
        return res.status(400).json({ error: '요청 본문에 url 또는 html 필드를 제공해야 합니다.' });
    }

    let browser = null;
    try {
        console.log(`[V4] 모드: ${url ? 'URL' : 'HTML'}, 클릭셀렉터: ${(clickSelectors || []).length}개, 숨김표시: ${showHidden}`);

        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ]
        });

        const page = await browser.newPage();
        let width = (viewport && viewport.width) || 1920;
        let height = (viewport && viewport.height) || 1080;
        await page.setViewport({ width, height });

        if (url) {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        } else if (html) {
            await page.setContent(html, { waitUntil: 'networkidle2', timeout: 30000 });
        }
        await new Promise(r => setTimeout(r, 4000)); // 애니메이션 및 그래프 렌더링 대기 (넉넉하게 4초)

        // ── 액션 수행 (클릭/호버) ─────────────────────────────
        const combinedActions = [];
        if (clickSelectors && clickSelectors.length > 0) {
            combinedActions.push(...clickSelectors.map(s => ({ type: 'click', selector: s })));
        }
        if (req.body.actions && req.body.actions.length > 0) {
            combinedActions.push(...req.body.actions);
        }

        for (const action of combinedActions) {
            try {
                await page.waitForSelector(action.selector, { timeout: 3000 });
                if (action.type === 'click') {
                    await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.scrollIntoView({ block: 'center', inline: 'center' });
                        }
                    }, action.selector);
                    await new Promise(r => setTimeout(r, 300));
                    // 사람처럼 실제 마우스 클릭 유도 (React 등 이벤트 캐치 호환성 향상)
                    await page.click(action.selector);
                    await new Promise(r => setTimeout(r, 600));
                } else if (action.type === 'hover') {
                    await page.hover(action.selector);
                    await new Promise(r => setTimeout(r, 600));
                }
            } catch (e) {
                console.warn(`[액션 실패] ${action.type}: ${action.selector}`);
            }
        }
        await new Promise(r => setTimeout(r, 3000)); // 액션이 모두 끝나고 레이아웃/앱 데이터가 완전히 로딩되기를 대기

        // ── 액션 완료 후 높이 다시 측정 및 뷰포트 최종 확장 ────────────────
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                let distance = 300;
                let timer = setInterval(() => {
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= document.body.scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
            window.scrollTo(0, 0);
        });

        const finalHeight = await page.evaluate(() => {
            return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        });

        if (finalHeight > height) {
            height = finalHeight;
            await page.setViewport({ width, height });
            await new Promise(r => setTimeout(r, 800));
        }

        // ── 모든 숨김 요소 강제 표시 ──────────────────────────────────
        if (showHidden) {
            await page.evaluate(() => {
                const els = document.querySelectorAll('*');
                for (const el of els) {
                    const s = window.getComputedStyle(el);
                    if (s.display === 'none') el.style.display = 'block';
                    if (s.visibility === 'hidden') el.style.visibility = 'visible';
                    if (parseFloat(s.opacity) === 0) el.style.opacity = '1';
                }
            });
            await new Promise(r => setTimeout(r, 300));
        }

        const domTree = await page.evaluate(() => {
            function rgbaToObj(rgba) {
                if (!rgba || rgba === 'rgba(0, 0, 0, 0)' || rgba === 'transparent') return null;
                const match = rgba.match(/[\d.]+/g);
                if (!match || match.length < 3) return null;
                return {
                    r: parseFloat(match[0]) / 255,
                    g: parseFloat(match[1]) / 255,
                    b: parseFloat(match[2]) / 255,
                    a: match.length > 3 ? parseFloat(match[3]) : 1
                };
            }

            // box-shadow 파싱
            function parseBoxShadow(shadow) {
                if (!shadow || shadow === 'none') return null;
                try {
                    const colorMatch = shadow.match(/rgba?\([^)]+\)/);
                    if (!colorMatch) return null;
                    const color = rgbaToObj(colorMatch[0]);
                    if (!color) return null;
                    const beforeColor = shadow.substring(0, shadow.indexOf(colorMatch[0])).trim();
                    const nums = beforeColor.match(/-?[\d.]+px/g);
                    if (!nums || nums.length < 2) return null;
                    return {
                        x: parseFloat(nums[0]),
                        y: parseFloat(nums[1]),
                        blur: nums[2] ? parseFloat(nums[2]) : 0,
                        spread: nums[3] ? parseFloat(nums[3]) : 0,
                        color: color
                    };
                } catch (e) { return null; }
            }

            // 아이콘 폰트 클래스 탐지 (FontAwesome, Lucide, Bootstrap Icons, Remix 등)
            const ICON_FONT_FAMILIES = ['fontawesome', 'font awesome', 'lucide', 'material', 'remixicon', 'ionicon', 'feather', 'bootstrap-icons'];
            const ICON_CLASS_PREFIXES = ['fa-solid', 'fa-regular', 'fa-brands', 'fa-light', 'fa-thin', 'fa-duotone', 'fas ', 'far ', 'fab ', 'fa ', 'lucide-', 'bi bi-', 'ri-', 'material-icons', 'icon-'];

            function hasIconFont(node, style) {
                const fontFamily = (style.fontFamily || '').toLowerCase();
                const isIconFont = ICON_FONT_FAMILIES.some(f => fontFamily.includes(f));
                const classNames = typeof node.className === 'string' ? node.className : '';
                const hasIconClass = ICON_CLASS_PREFIXES.some(c => classNames.includes(c));
                return isIconFont || hasIconClass;
            }

            function shouldCaptureAsImage(node, style) {
                const tag = node.tagName.toUpperCase();
                // IMG, CANVAS 등 명시적 이미지 태그
                if (['IMG', 'CANVAS', 'VIDEO', 'PICTURE'].includes(tag)) return true;
                // SVG는 자체 파싱
                if (tag === 'SVG') return false;
                // <i> 태그는 거의 항상 아이콘 폰트 → 무조건 스크린샷
                if (tag === 'I') return true;
                // 아이콘 폰트 클래스가 감지된 경우
                if (hasIconFont(node, style)) return true;
                // CSS background-image: url(...) 또는 gradient
                const bg = style.backgroundImage;
                if (bg && bg !== 'none') {
                    if (bg.startsWith('url(')) return true;
                    if (bg.includes('gradient')) return true; // 그라디언트 → 스크린샷
                }
                return false;
            }

            let nodeIndex = 0;
            const indexMap = new WeakMap(); // DOM node -> index

            function assignIndex(node) {
                indexMap.set(node, nodeIndex);
                nodeIndex++;
                Array.from(node.children).forEach(assignIndex);
            }
            assignIndex(document.body);

            function parseNode(node, parentRect = { x: 0, y: 0 }) {
                if (node.nodeType !== Node.ELEMENT_NODE) return null;
                const tagName = node.tagName.toUpperCase();
                if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'HEAD'].includes(tagName)) return null;

                const style = window.getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return null;

                const rect = node.getBoundingClientRect();
                if (rect.width < 0.5 || rect.height < 0.5) return null;
                if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(100%)') return null;
                // 완전히 문서/뷰포트 밖을 벗어나는 요소들 (sr-only, 라이브서버 배지 등) 제거
                if (rect.bottom < -50 || rect.right < -50 || rect.top > window.innerHeight + 100 || rect.left > window.innerWidth + 100) return null;

                const myRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                const captureAsImage = shouldCaptureAsImage(node, style);
                const isSVG = tagName === 'SVG';

                // 입력 필드(INPUT/TEXTAREA/SELECT) 가상 텍스트 자식 처리를 위해 값 보관
                let inputValue = "";
                if (!captureAsImage && !isSVG) {
                    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') {
                        let val = "";
                        if (tagName === 'SELECT') {
                            val = node.options && node.options[node.selectedIndex] ? node.options[node.selectedIndex].text : '';
                        } else {
                            val = node.value || node.getAttribute('placeholder') || '';
                        }
                        if (val && val.trim().length > 0) inputValue = val.trim();
                    }
                }
                const nodeIdx = indexMap.get(node) || 0;
                let nameSuffix = '';
                if (typeof node.className === 'string' && node.className.trim().length > 0) {
                    nameSuffix = '.' + node.className.trim().split(/\s+/)[0];
                }

                const obj = {
                    type: isSVG ? 'SVG' : (captureAsImage ? 'SCREENSHOT' : 'FRAME'),
                    name: tagName + nameSuffix,
                    nodeIndex: nodeIdx,
                    x: myRect.x,
                    y: myRect.y,
                    relX: myRect.x - parentRect.x,
                    relY: myRect.y - parentRect.y,
                    width: myRect.width,
                    height: myRect.height,
                    fills: rgbaToObj(style.backgroundColor),
                    color: rgbaToObj(style.color),
                    boxShadow: parseBoxShadow(style.boxShadow),
                    border: {
                        color: rgbaToObj(style.borderColor),
                        width: parseFloat(style.borderTopWidth) || 0
                    },
                    radius: parseFloat(style.borderTopLeftRadius) || 0,
                    overflowHidden: (
                        ['hidden', 'clip'].includes(style.overflow) ||
                        ['hidden', 'clip'].includes(style.overflowX) ||
                        ['hidden', 'clip'].includes(style.overflowY)
                    ),
                    opacity: style.opacity ? parseFloat(style.opacity) : 1,
                    filter: style.filter !== 'none' ? style.filter : null,
                    backdropFilter: style.backdropFilter !== 'none' ? style.backdropFilter : null,
                    children: []
                };

                if (isSVG) {
                    obj.svgContent = node.outerHTML;
                } else if (captureAsImage) {
                    obj.needsScreenshot = true;
                    obj.cssSelector = tagName + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' ? '.' + node.className.trim().split(/\s+/).join('.') : '');
                } else {
                    // 부모의 패딩 등으로 인해 위치가 달라질 수 있는 INPUT/TEXTAREA/SELECT 가상 자식 처리
                    if (inputValue) {
                        // 입력 요소 안의 텍스트가 대략적으로 패딩 값만큼 떨어져 있다고 가정
                        const pl = parseFloat(style.paddingLeft) || 0;
                        const pt = parseFloat(style.paddingTop) || 0;
                        obj.children.push({
                            type: 'TEXT',
                            name: 'VALUE',
                            relX: pl, relY: pt,
                            width: myRect.width - pl - (parseFloat(style.paddingRight) || 0),
                            height: myRect.height - pt - (parseFloat(style.paddingBottom) || 0),
                            characters: inputValue,
                            fontSize: parseFloat(style.fontSize) || 14,
                            fontWeight: style.fontWeight,
                            textAlign: style.textAlign || 'left',
                            textAlignVertical: 'center',
                            lineHeight: parseFloat(style.lineHeight) || 0,
                            letterSpacing: parseFloat(style.letterSpacing) || 0,
                            color: rgbaToObj(style.color),
                            fills: null, children: []
                        });
                    }

                    // 순수 Text 노드들에 대해 정확한 Bounding Rect 추출 
                    // Flexbox 등의 영향으로 글자가 임의의 위치에 정렬되더라도 브라우저 포지션을 백프로 반영
                    for (const child of node.childNodes) {
                        if (child.nodeType === Node.TEXT_NODE) {
                            const trimmed = child.textContent.trim();
                            if (trimmed.length > 0) {
                                const range = document.createRange();
                                range.selectNodeContents(child);
                                const tRect = range.getBoundingClientRect();
                                if (tRect.width > 0.5 && tRect.height > 0.5) {
                                    obj.children.push({
                                        type: 'TEXT',
                                        name: 'TEXT_NODE',
                                        relX: tRect.x - myRect.x,
                                        relY: tRect.y - myRect.y,
                                        // 여유 버퍼 공간 2px 더하기 (글꼴 차이로 인한 예상치 못한 줄바꿈 방지)
                                        width: tRect.width + 2,
                                        height: tRect.height + 2,
                                        characters: trimmed,
                                        fontSize: parseFloat(style.fontSize) || 14,
                                        fontWeight: style.fontWeight,
                                        textAlign: style.textAlign || 'left',
                                        lineHeight: parseFloat(style.lineHeight) || 0,
                                        letterSpacing: parseFloat(style.letterSpacing) || 0,
                                        color: rgbaToObj(style.color),
                                        fills: null, children: []
                                    });
                                }
                            }
                        } else if (child.nodeType === Node.ELEMENT_NODE) {
                            const parsed = parseNode(child, myRect);
                            if (parsed) obj.children.push(parsed);
                        }
                    }
                }

                return obj;
            }

            return parseNode(document.body);
        });

        // 2단계: "SCREENSHOT" 타입 노드들을 Puppeteer에서 개별 element 스크린샷으로 캡처
        async function captureScreenshotNodes(node) {
            if (!node) return;

            if (node.needsScreenshot) {
                try {
                    // nodeIndex를 이용해 DOM에서 해당 노드를 찾아 스크린샷
                    const elementHandle = await page.evaluateHandle((idx) => {
                        let count = 0;
                        function find(node) {
                            if (count === idx) return node;
                            count++;
                            for (const child of node.children) {
                                const result = find(child);
                                if (result) return result;
                            }
                            return null;
                        }
                        return find(document.body);
                    }, node.nodeIndex);

                    if (elementHandle) {
                        const screenshot = await elementHandle.screenshot({ type: 'png', encoding: 'base64' });
                        if (screenshot) {
                            node.base64 = `data:image/png;base64,${screenshot}`;
                        }
                        await elementHandle.dispose();
                    }
                } catch (e) {
                    console.warn(`[캡처 실패] ${node.name}:`, e.message);
                }
            }

            if (node.children) {
                for (const child of node.children) {
                    await captureScreenshotNodes(child);
                }
            }
        }

        await captureScreenshotNodes(domTree);

        console.log(`[V4 처리 완료] 하이브리드 파싱 성공`);

        return res.status(200).json({
            success: true,
            data: domTree
        });

    } catch (error) {
        console.error('[에러 발생]:', error);
        return res.status(500).json({ error: '웹 페이지 파싱 실패', details: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// ── 통이미지 캡처 API (인터랙티브 상태 적용) ─────────────────────────
app.post('/api/screenshot-image', async (req, res) => {
    const { url, html, viewport, clickSelectors, actions, showHidden } = req.body;
    if (!url && !html) return res.status(400).json({ error: 'url 또는 html 필요' });

    let browser = null;
    try {
        console.log(`[통이미지 캡처] URL: ${url}, 호버/클릭 수: ${(actions || []).length}`);
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process']
        });
        const page = await browser.newPage();
        let width = (viewport && viewport.width) || 1920;
        let height = (viewport && viewport.height) || 1080;
        await page.setViewport({ width, height });

        if (url) await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        else if (html) await page.setContent(html, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 4000)); // 애니메이션 및 그래프 렌더링 대기

        // 액션 수행 (클릭/호버)
        const combinedActions = [];
        if (clickSelectors && clickSelectors.length > 0) combinedActions.push(...clickSelectors.map(s => ({ type: 'click', selector: s })));
        if (actions && actions.length > 0) combinedActions.push(...actions);

        for (const action of combinedActions) {
            try {
                await page.waitForSelector(action.selector, { timeout: 3000 });
                if (action.type === 'click') {
                    await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        if (el) {
                            el.scrollIntoView({ block: 'center', inline: 'center' });
                        }
                    }, action.selector);
                    await new Promise(r => setTimeout(r, 300));
                    // 사람처럼 실제 마우스 클릭 유도 (React 등 이벤트 캐치 호환성 향상)
                    await page.click(action.selector);
                    await new Promise(r => setTimeout(r, 600));
                } else if (action.type === 'hover') {
                    await page.hover(action.selector);
                    await new Promise(r => setTimeout(r, 600));
                }
            } catch (e) {
                console.warn(`[액션 실패] ${action.type}: ${action.selector}`);
            }
        }
        await new Promise(r => setTimeout(r, 3000)); // 액션이 모두 끝나고 레이아웃/앱 데이터가 완전히 로딩되기를 대기

        // 높이 측정 및 확장 (액션 완료 후 최종 측정)
        await page.evaluate(async () => {
            await new Promise(resolve => {
                let th = 0, d = 300;
                let t = setInterval(() => { window.scrollBy(0, d); th += d; if (th >= document.body.scrollHeight) { clearInterval(t); resolve(); } }, 100);
            });
            window.scrollTo(0, 0);
        });
        const finalHeight = await page.evaluate(() => {
            return Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        });
        if (finalHeight > height) {
            height = finalHeight;
            await page.setViewport({ width, height });
            await new Promise(r => setTimeout(r, 800));
        }

        if (showHidden) {
            await page.evaluate(() => {
                document.querySelectorAll('*').forEach(el => {
                    const s = window.getComputedStyle(el);
                    if (s.display === 'none') el.style.display = 'block';
                    if (s.visibility === 'hidden') el.style.visibility = 'visible';
                    if (parseFloat(s.opacity) === 0) el.style.opacity = '1';
                });
            });
            await new Promise(r => setTimeout(r, 300));
        }

        // 전체 화면 스크린샷 캡처
        const screenshotBase64 = await page.screenshot({ type: 'png', encoding: 'base64', fullPage: true });
        return res.status(200).json({ success: true, base64: 'data:image/png;base64,' + screenshotBase64, width, height });

    } catch (e) {
        return res.status(500).json({ error: '웹 페이지 통이미지 캡처 실패', details: e.message });
    } finally {
        if (browser) await browser.close();
    }
});
// 프리뷰 준비를 위해 타겟 도메인과 경로를 세팅하고 브라우저 쿠키에 저장하는 엔드포인트
app.get('/api/set-target', (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('url parameter is required');

    try {
        const urlObj = new URL(url);
        const targetOrigin = urlObj.origin;
        // 쿠키에 타겟 도메인 저장 (모든 하위 경로에서 프록시가 이 타겟을 바라보도록 설정)
        res.cookie('target_domain', targetOrigin, { path: '/', httpOnly: true, sameSite: 'none', secure: true });

        // 원본과 동일한 경로(pathname + search)로 iframe 렌더링
        const targetPath = urlObj.pathname + urlObj.search;
        res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>
html, body { margin:0; padding:0; width:100%; height:100%; overflow:hidden; }
iframe { display:block; width:100%; height:100%; border:none; }
</style>
</head>
<body>
<iframe id="proxied" src="${targetPath}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation"></iframe>
<script>
var child = document.getElementById('proxied');
function sendToParent(msg) { if(window.parent) window.parent.postMessage(msg,'*'); }
function getSelector(el) {
    if(!el||el.tagName.toLowerCase()==='html'||el.tagName.toLowerCase()==='body') return 'body';
    var path=[],node=el;
    while(node&&node.nodeType===1){
        var sel=node.nodeName.toLowerCase();
        if(node.id){path.unshift('#'+node.id);break;}
        var sib=node,nth=1;
        while((sib=sib.previousElementSibling)){if(sib.nodeName.toLowerCase()===sel)nth++;}
        if(nth!==1)sel+=':nth-of-type('+nth+')';
        path.unshift(sel);node=node.parentNode;
    }
    return path.join(' > ');
}
child.onload = function() {
    var doc = child.contentDocument;
    if(!doc) return;
    doc.addEventListener('keydown', function(e){
        if(e.ctrlKey&&e.shiftKey&&(e.key==='C'||e.key==='c')){
            e.preventDefault();
            sendToParent({type:'shortcut-capture'});
        }
    });
    doc.addEventListener('click', function(e){
        sendToParent({type:'recorded-action', action:'click', selector:getSelector(e.target)});
    }, true);
    doc.addEventListener('contextmenu', function(e){
        if(e.shiftKey) return;
        e.preventDefault();
        sendToParent({type:'recorded-action', action:'hover', selector:getSelector(e.target)});
    }, true);
};
</script>
</body>
</html>`);
    } catch (e) {
        res.status(400).send('Invalid URL');
    }
});

// 나머지 모든 요청은 쿠키에 저장된 타겟 도메인으로 리버스 프록싱 (Vite/React 에셋 및 API 모두 정상 작동)
app.use('/', (req, res, next) => {
    if (!req.cookies.target_domain && req.path !== '/api/set-target') {
        return res.status(400).send('Preview target domain missing. Needs to visit /api/set-target first.');
    }
    next();
}, createProxyMiddleware({
    target: 'https://example.com', // MUST be https to avoid proxy protocol mismatch hang
    router: (req) => {
        return req.cookies.target_domain;
    },
    changeOrigin: true,
    ws: true, // 웹소켓(HMR 등) 지원
    onProxyReq: (proxyReq, req, res) => {
        if (req.cookies.target_domain) {
            proxyReq.setHeader('origin', req.cookies.target_domain);
        }
    },
    onProxyRes: (proxyRes, req, res) => {
        // iframe 표시 차단 헤더 제거
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
    }
}));

app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`🚀 (V4 하이브리드) API 서버 실행 중...`);
    console.log(`👉 http://localhost:${PORT}`);
    console.log(`=========================================`);
});
