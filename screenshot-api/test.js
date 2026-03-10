const puppeteer = require('puppeteer');
(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto('https://topik-ai-nqgl.vercel.app/writing_feedback_detail_54.html?mode=review', { waitUntil: 'networkidle0' });
    const canvasCount = await page.$$eval('canvas', els => els.length);
    const svgCount = await page.$$eval('svg', els => els.length);
    const imgCount = await page.$$eval('img', els => els.length);
    const graphGrayBoxes = await page.$$eval('div', els => els.filter(e => e.innerText && e.innerText.includes('Graph Image')).length);
    console.log(`Canvas: ${canvasCount}, SVG: ${svgCount}, IMG: ${imgCount}, GraphGrayBoxes: ${graphGrayBoxes}`);
    await browser.close();
})();
