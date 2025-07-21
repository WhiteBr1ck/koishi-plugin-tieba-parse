import { Context, Schema, h, Logger } from 'koishi'
import { Page } from 'puppeteer-core'
import type {} from 'koishi-plugin-puppeteer'


export const name = 'tieba-parser-final'

export const using = ['puppeteer']

// 插件配置项
export interface Config {
  debugMode: boolean
  width: number
  screenshotHeight: number
  showTitle: boolean
  extractFirstPostText: boolean
  extractFirstPostImages: boolean
  extractFirstPostVideo: boolean
  cookie: string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    width: Schema.number().default(800).description('截图的默认宽度（像素）。'),
    screenshotHeight: Schema.number().default(0).description('设置截图的最大高度（像素）。设置为 0 则代表不限制高度，截取帖子第一页的所有内容。'),
    showTitle: Schema.boolean().default(true).description('是否在截图上方显示帖子标题。'),
    extractFirstPostText: Schema.boolean().default(true).description('是否在截图前提取并发送1楼的纯文本内容。'),
    extractFirstPostImages: Schema.boolean().default(true).description('是否在截图下方提取并发送1楼的全部图片。'),
    extractFirstPostVideo: Schema.boolean().default(true).description('是否提取并发送1楼的视频（若存在）。'),
  }).description('解析设置'),

  Schema.object({
    cookie: Schema.string().role('textarea').description('请通过 /tieba.login 指令获取。'),
  }).description('登录信息'),

  Schema.object({
    debugMode: Schema.boolean().default(false).description('启用调试模式。开启后，将在后台控制台输出详细的操作日志。'),
  }).description('调试'),
])


// 正则
const TIEBA_REG = /(tieba\.baidu\.com\/p\/(\d+))|(jump\.bdimg\.com\/p\/(\d+))/

// Cookie 格式化函数
function formatCookie(cookies: any[]): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// Cookie 解析函数
function parseCookie(cookieString: string): any[] {
  if (!cookieString) return []
  return cookieString.split(';').map(pair => {
    const parts = pair.split('=');
    const name = parts.shift().trim()
    const value = parts.join('=').trim()
    return { name, value, domain: '.baidu.com' }
  })
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('tieba-parser')

  // 用于登录
  ctx.command('tieba.login', '获取贴吧 Cookie')
    .action(async ({ session }) => {
      let page: Page
      try {
        await session.send('正在获取登录二维码，请稍候...')
        
        page = await ctx.puppeteer.page()
        
        const loginUrl = 'https://passport.baidu.com/v2/?login&tpl=tb&u=https%3A%2F%2Ftieba.baidu.com'
        await page.goto(loginUrl)

        const qrCodeElement = await page.waitForSelector('.tang-pass-qrcode-img');
        const qrCodeImage = await qrCodeElement.screenshot({ type: 'png' })
        
        await session.send([
          h.image(qrCodeImage, 'image/png'),
          h('p', '请在2分钟内使用【百度贴吧】App扫描二维码登录。'),
        ])
        
        await page.waitForNavigation({ timeout: 120000 });
        
        const cookies = await page.cookies('https://baidu.com', 'https://tieba.baidu.com');
        const cookieString = formatCookie(cookies)

        if (!cookieString || !cookieString.includes('BDUSS')) {
            return '登录失败：未能获取到关键的登录凭证 (BDUSS)，请重试。'
        }
        
        return '登录成功！\n请将以下 Cookie 完整复制并粘贴到插件的【登录信息】配置项中：\n' + cookieString

      } catch (error) {
        logger.error('扫码登录失败！\n' + error.stack)
        return '登录失败或超时，请重试。'
      } finally {
        if (page) await page.close()
      }
    })

  // 核心中间件
  ctx.middleware(async (session, next) => {
    const prefixes = Array.isArray(ctx.options.prefix) ? ctx.options.prefix : [ctx.options.prefix];
    const commandPrefixes = prefixes.filter(p => p && typeof p === 'string');
    if (commandPrefixes.some(p => session.content.startsWith(p))) {
      return next();
    }
    
    const match = TIEBA_REG.exec(session.content)
    if (!match) return next()

    const postId = match[2] || match[4]
    const targetUrl = `https://tieba.baidu.com/p/${postId}`
    if (config.debugMode) logger.info('匹配到贴吧链接，ID: %s', postId)
    
    const pinger = await session.send([
        h('quote', { id: session.messageId }),
        '识别到贴吧链接，正在为您生成内容...'
    ]);
    const pingerId = pinger?.[0];

    let page: Page
    try {
      if (config.debugMode) logger.info('准备启动 Puppeteer 页面...')
      page = await ctx.puppeteer.page()
      
      if (config.cookie) {
        await page.setCookie(...parseCookie(config.cookie))
        if (config.debugMode) logger.info('已设置全局 Cookie。')
      }
      
      await page.setViewport({ width: config.width, height: 1080 })
      await page.goto(targetUrl, { waitUntil: 'networkidle2' })
      if (config.debugMode) logger.info('页面已导航至: %s', targetUrl)

      const extractedData = await page.evaluate((cfg) => {
        const data = { postTitle: '', firstPostText: '', imageUrls: [], videoUrl: '' };
        if (cfg.showTitle) { data.postTitle = document.title.replace(/_百度贴吧$/, '').trim(); }
        const firstPost = document.querySelector('.l_post');
        if (!firstPost) return data;
        const contentElement = firstPost.querySelector('.d_post_content_main .p_content');
        if (contentElement) {
          if (cfg.extractFirstPostText) { data.firstPostText = (contentElement as HTMLElement).innerText.trim(); }
          if (cfg.extractFirstPostImages) { const imageElements = contentElement.querySelectorAll('img.BDE_Image'); data.imageUrls = Array.from(imageElements).map(img => (img as HTMLImageElement).src); }
        }
        if (cfg.extractFirstPostVideo) { const videoElement = firstPost.querySelector('.d_post_content_main video'); if (videoElement) { data.videoUrl = (videoElement as HTMLVideoElement).src; } }
        return data;
      }, { showTitle: config.showTitle, extractFirstPostText: config.extractFirstPostText, extractFirstPostImages: config.extractFirstPostImages, extractFirstPostVideo: config.extractFirstPostVideo });

      const { postTitle, firstPostText, imageUrls, videoUrl } = extractedData;
      if (config.debugMode) logger.info('数据提取完成: 标题=%s, 文本长度=%d, 图片数=%d, 视频=%s', !!postTitle, firstPostText.length, imageUrls.length, !!videoUrl);
      
      await page.evaluate(async () => {
          let lastHeight = -1; let currentHeight = 0; let tries = 0;
          while(lastHeight < currentHeight && tries < 15) { window.scrollTo(0, document.body.scrollHeight); lastHeight = currentHeight; await new Promise(resolve => setTimeout(resolve, 500)); currentHeight = document.body.scrollHeight; tries++; }
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise(resolve => setTimeout(resolve, 100));

      await page.addStyleTag({ content: `#com_userbar, .tb-header, .right_section, .core_reply_wrapper, .app_download_wrap, .see-more-wrap, .tb_rich_poster_container, .footer, .j_user_sign, .quick_reply_button, .share_btn_wrapper, .celebrity, .post-client-promotion, .lottery-exp-wrap, .simple-card, .vip-red-name-honour-wrap, .bawu-button-wrapper, .video_header_wrap, .fix_bar_wrap { display: none !important; } .pb_content { width: auto !important; }` })

      const contentArea = await page.$('#j_p_postlist')
      if (!contentArea) throw new Error('无法找到帖子内容区域 #j_p_postlist。')
      
      const boundingBox = await contentArea.boundingBox();
      if (!boundingBox) throw new Error('无法获取帖子内容的边界框。')
      
      const clip = { x: boundingBox.x, y: boundingBox.y, width: boundingBox.width, height: config.screenshotHeight > 0 ? config.screenshotHeight : boundingBox.height };
      clip.height = Math.min(clip.height, boundingBox.height);
      const imageBuffer = await page.screenshot({ clip });

      const mainMessage = [];
      if (postTitle) mainMessage.push(h('p', postTitle));
      if (firstPostText) mainMessage.push(firstPostText);
      mainMessage.push(h.image(imageBuffer, 'image/png'));
      if (imageUrls.length > 0) mainMessage.push(...imageUrls.map(url => h.image(url)));
      await session.send(mainMessage);

      if (videoUrl) {
          await session.send(h.video(videoUrl));
      }
      
      return; 

    } catch (error) {
      logger.error('贴吧解析过程中发生严重错误！\n' + error.stack)
      return `解析失败，可能是帖子不存在或网络问题。请管理员检查后台日志以获取详细错误信息。`
    } finally {
      if (page) {
        await page.close()
        if (config.debugMode) logger.info('Puppeteer 页面已关闭。')
      }
      if (pingerId) {
        try {
          await session.bot.deleteMessage(session.channelId, pingerId);
          if (config.debugMode) logger.info('已撤回“正在生成”的提示消息。');
        } catch(e) {
          if (config.debugMode) logger.warn('撤回提示消息失败，可能缺少权限。', e)
        }
      }
    }
  })
}