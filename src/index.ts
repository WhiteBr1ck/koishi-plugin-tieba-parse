import { Context, Schema, h } from 'koishi'
import { Page } from 'puppeteer-core'
import type {} from 'koishi-plugin-puppeteer'

export const name = 'tieba-parser-final'

export const using = ['puppeteer']

type ResolvedFrontend = 'old' | 'new'

type ParseOptions = Pick<Config, 'showTitle' | 'extractFirstPostText' | 'extractFirstPostImages' | 'extractFirstPostVideo'>

interface ExtractedData {
  postTitle: string
  firstPostText: string
  imageUrls: string[]
  videoUrl: string
}

interface FrontendStrategy {
  mode: ResolvedFrontend
  screenshotSelector: string
  readySelectors: string[]
  cleanupCss: string
  extract(page: Page, options: ParseOptions): Promise<ExtractedData>
}

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

const OLD_FRONTEND: FrontendStrategy = {
  mode: 'old',
  screenshotSelector: '#j_p_postlist',
  readySelectors: ['#j_p_postlist', '.l_post'],
  cleanupCss: `#com_userbar, .tb-header, .right_section, .core_reply_wrapper, .app_download_wrap, .see-more-wrap, .tb_rich_poster_container, .footer, .j_user_sign, .quick_reply_button, .share_btn_wrapper, .celebrity, .post-client-promotion, .lottery-exp-wrap, .simple-card, .vip-red-name-honour-wrap, .bawu-button-wrapper, .video_header_wrap, .fix_bar_wrap { display: none !important; } .pb_content { width: auto !important; }`,
  async extract(page, cfg) {
    const data = await page.evaluate((cfg) => {
      const result = { postTitle: '', firstPostText: '', imageUrls: [] as string[], videoUrl: '' }
      if (cfg.showTitle) {
        result.postTitle = document.title.replace(/_百度贴吧$/, '').trim()
      }

      const firstPost = document.querySelector('.l_post')
      if (!firstPost) return result

      const contentElement = firstPost.querySelector('.d_post_content_main .p_content')
      if (contentElement) {
        if (cfg.extractFirstPostText) {
          result.firstPostText = (contentElement as HTMLElement).innerText.trim()
        }

        if (cfg.extractFirstPostImages) {
          const imageElements = contentElement.querySelectorAll('img.BDE_Image')
          result.imageUrls = Array.from(imageElements)
            .map((img) => {
              const element = img as HTMLImageElement
              return element.currentSrc || element.src || element.dataset.src || element.getAttribute('data-src') || ''
            })
            .filter(Boolean)
        }
      }

      if (cfg.extractFirstPostVideo) {
        const videoElement = firstPost.querySelector('.d_post_content_main video') as HTMLVideoElement | null
        if (videoElement) {
          result.videoUrl = videoElement.currentSrc || videoElement.src || ''
        }
      }

      return result
    }, cfg)

    return normalizeExtractedData(data)
  },
}

const NEW_FRONTEND_READY_SELECTORS = ['.center-content', '.pb-title']

function formatCookie(cookies: any[]): string {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ')
}

function parseCookie(cookieString: string): any[] {
  if (!cookieString) return []
  return cookieString.split(';').map(pair => {
    const parts = pair.split('=')
    const name = parts.shift()?.trim()
    const value = parts.join('=').trim()
    return { name, value, domain: '.baidu.com' }
  }).filter(cookie => cookie.name)
}

function cleanExtractedText(text: string): string {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^点击展开，查看完整(?:图片|视频)$/.test(line))
    .join('\n')
    .trim()
}

function normalizeExtractedData(data: ExtractedData): ExtractedData {
  return {
    postTitle: (data.postTitle || '').trim(),
    firstPostText: cleanExtractedText(data.firstPostText || ''),
    imageUrls: Array.from(new Set((data.imageUrls || []).map(url => url.trim()).filter(Boolean))),
    videoUrl: (data.videoUrl || '').trim(),
  }
}

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function logDebug(logger: ReturnType<Context['logger']>, enabled: boolean, message: string, ...args: any[]) {
  if (enabled) logger.info(message, ...args)
}

async function hasSelectors(page: Page, selectors: string[]): Promise<boolean> {
  return page.evaluate((selectors) => {
    return selectors.every(selector => !!document.querySelector(selector))
  }, selectors)
}

async function waitForSelectors(page: Page, selectors: string[], timeout = 10000): Promise<boolean> {
  const start = Date.now()

  while (Date.now() - start < timeout) {
    try {
      if (await hasSelectors(page, selectors)) return true
    } catch {}

    await wait(300)
  }

  return false
}

async function detectFrontend(page: Page): Promise<ResolvedFrontend | null> {
  if (await hasSelectors(page, OLD_FRONTEND.readySelectors)) {
    return 'old'
  }

  if (await hasSelectors(page, NEW_FRONTEND_READY_SELECTORS)) {
    return 'new'
  }

  return null
}

async function clickIconTarget(page: Page, iconId: string, logger: ReturnType<Context['logger']>, debugMode: boolean) {
  const target = await page.evaluate((iconId) => {
    const isVisible = (element: Element | null) => {
      if (!element) return false
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }

    const isInteractive = (element: Element) => {
      if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement) return true
      const role = element.getAttribute('role')
      if (role === 'button' || role === 'menuitem' || role === 'link') return true
      if (element.hasAttribute('onclick') || element.getAttribute('tabindex') !== null) return true
      return window.getComputedStyle(element).cursor === 'pointer'
    }

    const normalizeUrl = (value: string | null) => {
      if (!value) return ''
      try {
        return new URL(value, location.href).href
      } catch {
        return value
      }
    }

    const pickTarget = (use: Element) => {
      const preferred = [
        use.closest('button, a, [role="button"], [role="menuitem"], [role="link"], .menu-item, .menu-item-content, .more-btn, .operate-btn, li'),
      ].filter(Boolean) as Element[]

      let current: Element | null = use
      while (current && preferred.length < 10) {
        preferred.push(current)
        current = current.parentElement
      }

      const seen = new Set<Element>()
      for (const candidate of preferred) {
        if (seen.has(candidate)) continue
        seen.add(candidate)
        if (!isVisible(candidate)) continue

        const rect = candidate.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue

        const rawHref = candidate instanceof HTMLAnchorElement
          ? candidate.href
          : candidate.getAttribute('href') || candidate.getAttribute('data-href') || candidate.getAttribute('data-url')

        if (!isInteractive(candidate) && !rawHref) continue

        const className = candidate.getAttribute('class') || ''

        return {
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          href: normalizeUrl(rawHref),
          tag: candidate.tagName.toLowerCase(),
          text: (candidate.textContent || '').trim().slice(0, 80),
          className,
        }
      }

      return null
    }

    const uses = Array.from(document.querySelectorAll('use')).filter((node) => {
      return node.getAttribute('xlink:href') === `#${iconId}` || node.getAttribute('href') === `#${iconId}`
    })

    for (const use of uses) {
      const target = pickTarget(use)
      if (target) return target
    }

    return null
  }, iconId)

  if (!target) {
    logDebug(logger, debugMode, '未定位到 %s 图标对应的可点击目标。', iconId)
    return null
  }

  logDebug(logger, debugMode, '定位到 %s 图标目标: %o', iconId, target)
  await page.mouse.move(target.x, target.y)
  await page.mouse.down()
  await page.mouse.up()
  return target
}

async function waitForOldFrontendSwitch(page: Page, initialUrl: string, logger: ReturnType<Context['logger']>, debugMode: boolean, fallbackUrl = ''): Promise<boolean> {
  const start = Date.now()
  let lastUrl = initialUrl

  while (Date.now() - start < 15000) {
    try {
      if (await hasSelectors(page, OLD_FRONTEND.readySelectors)) return true

      const currentUrl = page.url()
      if (currentUrl !== lastUrl) {
        logDebug(logger, debugMode, '切页过程中 URL 变化: %s -> %s', lastUrl, currentUrl)
        lastUrl = currentUrl
      }
    } catch {}

    await wait(300)
  }

  if (fallbackUrl && fallbackUrl !== page.url()) {
    logDebug(logger, debugMode, '点击未直接切页，尝试使用菜单目标地址进入旧版: %s', fallbackUrl)
    try {
      await page.goto(fallbackUrl, { waitUntil: 'networkidle2' })
      const ready = await waitForSelectors(page, OLD_FRONTEND.readySelectors, 15000)
      logDebug(logger, debugMode, '通过菜单目标地址进入旧版结果: %s', ready)
      if (ready) return true
    } catch (error) {
      logDebug(logger, debugMode, '通过菜单目标地址进入旧版失败: %s', error instanceof Error ? error.message : String(error))
    }
  }

  const finalState = await page.evaluate(() => ({
    href: location.href,
    title: document.title,
    oldRoot: !!document.querySelector('#j_p_postlist'),
    oldPost: !!document.querySelector('.l_post'),
    centerContent: !!document.querySelector('.center-content'),
    pbTitle: !!document.querySelector('.pb-title'),
  }))
  logDebug(logger, debugMode, '旧版切换后页面状态: %o', finalState)
  return false
}

async function switchToOldFrontend(page: Page, logger: ReturnType<Context['logger']>, debugMode: boolean): Promise<boolean> {
  logDebug(logger, debugMode, '尝试切换到旧版贴吧前端。')

  const beforeUrl = page.url()
  const ellipsisTarget = await clickIconTarget(page, 'ellipsis', logger, debugMode)
  const openedMenu = !!ellipsisTarget
  if (openedMenu) await wait(500)

  const backOldTarget = await clickIconTarget(page, 'back_old', logger, debugMode)
  const clickedBackOld = !!backOldTarget

  logDebug(logger, debugMode, '旧版切换点击结果: %o', {
    openedMenu,
    clickedBackOld,
    backOldHref: backOldTarget?.href || '',
  })

  if (!clickedBackOld) {
    logDebug(logger, debugMode, '未找到“回旧版”按钮。')
    return false
  }

  const switched = await waitForOldFrontendSwitch(page, beforeUrl, logger, debugMode, backOldTarget?.href || '')
  logDebug(logger, debugMode, '旧版前端切换结果: %s', switched)
  return switched
}

async function scrollPageForLazyContent(page: Page) {
  await page.evaluate(async () => {
    let lastHeight = -1
    let currentHeight = 0
    let tries = 0

    while (lastHeight < currentHeight && tries < 15) {
      window.scrollTo(0, document.body.scrollHeight)
      lastHeight = currentHeight
      await new Promise((resolve) => setTimeout(resolve, 500))
      currentHeight = document.body.scrollHeight
      tries++
    }
  })

  await page.evaluate(() => window.scrollTo(0, 0))
  await wait(100)
}

async function captureContentScreenshot(page: Page, strategy: FrontendStrategy, screenshotHeight: number, logger: ReturnType<Context['logger']>, debugMode: boolean) {
  await page.addStyleTag({ content: strategy.cleanupCss })

  const contentArea = await page.$(strategy.screenshotSelector)
  if (!contentArea) {
    throw new Error(`无法找到截图区域 ${strategy.screenshotSelector}。`)
  }

  const boundingBox = await contentArea.boundingBox()
  if (!boundingBox) {
    throw new Error(`无法获取截图区域 ${strategy.screenshotSelector} 的边界框。`)
  }

  const clip = {
    x: boundingBox.x,
    y: boundingBox.y,
    width: boundingBox.width,
    height: screenshotHeight > 0 ? Math.min(screenshotHeight, boundingBox.height) : boundingBox.height,
  }

  clip.height = Math.max(clip.height, 1)
  logDebug(logger, debugMode, '截图边界: mode=%s anchor=%s contentHeight=%d finalHeight=%d', strategy.mode, 'container', Math.round(boundingBox.height), Math.round(clip.height))
  return page.screenshot({ clip })
}

async function parseWithStrategy(page: Page, strategy: FrontendStrategy, config: Config, logger: ReturnType<Context['logger']>) {
  const ready = await waitForSelectors(page, strategy.readySelectors, 10000)
  if (!ready) {
    throw new Error(`未检测到 ${strategy.mode} 版页面的关键节点。`)
  }

  await scrollPageForLazyContent(page)
  const data = await strategy.extract(page, config)
  logDebug(logger, config.debugMode, '使用 %s 版前端解析成功：标题=%s, 文本长度=%d, 图片数=%d, 视频=%s', strategy.mode, !!data.postTitle, data.firstPostText.length, data.imageUrls.length, !!data.videoUrl)

  const imageBuffer = await captureContentScreenshot(page, strategy, config.screenshotHeight, logger, config.debugMode)
  return { mode: strategy.mode, data, imageBuffer }
}

async function parseTiebaPage(page: Page, config: Config, logger: ReturnType<Context['logger']>) {
  const resolved = await detectFrontend(page)
  logDebug(logger, config.debugMode, '检测到当前贴吧前端: %s', resolved || 'unknown')

  let lastError: unknown

  try {
    if (resolved === 'old') {
      logDebug(logger, config.debugMode, '识别为旧版前端，直接解析。')
      return parseWithStrategy(page, OLD_FRONTEND, config, logger)
    }

    if (resolved === 'new') {
      logDebug(logger, config.debugMode, '识别为新版前端，准备切回旧版。')
      const switched = await switchToOldFrontend(page, logger, config.debugMode)
      if (!switched) {
        throw new Error('未找到切换到旧版前端的入口，或切换未生效。')
      }
      return parseWithStrategy(page, OLD_FRONTEND, config, logger)
    }

    const readyNew = await waitForSelectors(page, NEW_FRONTEND_READY_SELECTORS, 4000)
    if (readyNew) {
      logDebug(logger, config.debugMode, '延迟识别为新版前端，准备切回旧版。')
      const switched = await switchToOldFrontend(page, logger, config.debugMode)
      if (!switched) {
        throw new Error('未找到切换到旧版前端的入口，或切换未生效。')
      }
      return parseWithStrategy(page, OLD_FRONTEND, config, logger)
    }

    const readyOld = await waitForSelectors(page, OLD_FRONTEND.readySelectors, 4000)
    if (readyOld) {
      logDebug(logger, config.debugMode, '延迟识别为旧版前端。')
      return parseWithStrategy(page, OLD_FRONTEND, config, logger)
    }
  } catch (error) {
    lastError = error
    if (config.debugMode) {
      const reason = error instanceof Error ? error.message : String(error)
      logger.warn('贴吧页面解析失败：%s', reason)
    }
  }

  throw lastError || new Error('未能识别当前贴吧页面结构。')
}

export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger('tieba-parser')

  ctx.command('tieba.login', '获取贴吧 Cookie')
    .action(async ({ session }) => {
      let page: Page
      try {
        await session.send('正在获取登录二维码，请稍候...')

        page = await ctx.puppeteer.page()

        const loginUrl = 'https://passport.baidu.com/v2/?login&tpl=tb&u=https%3A%2F%2Ftieba.baidu.com'
        await page.goto(loginUrl)

        const qrCodeElement = await page.waitForSelector('.tang-pass-qrcode-img')
        const qrCodeImage = await qrCodeElement.screenshot({ type: 'png' })

        await session.send([
          h.image(qrCodeImage, 'image/png'),
          h('p', '请在2分钟内使用【百度贴吧】App扫描二维码登录。'),
        ])

        await page.waitForNavigation({ timeout: 120000 })

        const cookies = await page.cookies('https://baidu.com', 'https://tieba.baidu.com')
        const cookieString = formatCookie(cookies)

        if (!cookieString || !cookieString.includes('BDUSS')) {
          return '登录失败：未能获取到关键的登录凭证 (BDUSS)，请重试。'
        }

        return '登录成功！\n请将以下 Cookie 完整复制并粘贴到插件的【登录信息】配置项中：\n' + cookieString
      } catch (error) {
        const detail = error instanceof Error ? error.stack || error.message : String(error)
        logger.error('扫码登录失败！\n' + detail)
        return '登录失败或超时，请重试。'
      } finally {
        if (page) await page.close()
      }
    })

  ctx.middleware(async (session, next) => {
    const content = session.content || ''
    const prefixes = Array.isArray(ctx.options.prefix) ? ctx.options.prefix : [ctx.options.prefix]
    const commandPrefixes = prefixes.filter(p => p && typeof p === 'string')
    if (commandPrefixes.some(p => content.startsWith(p))) {
      return next()
    }

    const match = TIEBA_REG.exec(content)
    if (!match) return next()

    const postId = match[2] || match[4]
    const targetUrl = `https://tieba.baidu.com/p/${postId}`
    logDebug(logger, config.debugMode, '匹配到贴吧链接，ID: %s', postId)

    const pinger = await session.send([
      h('quote', { id: session.messageId }),
      '识别到贴吧链接，正在为您生成内容...'
    ])
    const pingerId = pinger?.[0]

    let page: Page
    try {
      logDebug(logger, config.debugMode, '准备启动 Puppeteer 页面...')
      page = await ctx.puppeteer.page()

      if (config.cookie) {
        await page.setCookie(...parseCookie(config.cookie))
        logDebug(logger, config.debugMode, '已设置全局 Cookie。')
      }

      await page.setViewport({ width: config.width, height: 1080 })
      await page.goto(targetUrl, { waitUntil: 'networkidle2' })
      logDebug(logger, config.debugMode, '页面已导航至: %s', targetUrl)

      const { data, imageBuffer, mode } = await parseTiebaPage(page, config, logger)
      const { postTitle, firstPostText, imageUrls, videoUrl } = data
      logDebug(logger, config.debugMode, '最终采用前端模式: %s', mode)

      const mainMessage = []
      const textBlocks = []
      if (postTitle) textBlocks.push(`标题：\n${postTitle}`)
      if (firstPostText) textBlocks.push(`正文：\n${firstPostText}`)
      if (textBlocks.length > 0) mainMessage.push(textBlocks.join('\n\n'))
      mainMessage.push(h.image(imageBuffer, 'image/png'))
      if (imageUrls.length > 0) mainMessage.push(...imageUrls.map(url => h.image(url)))
      await session.send(mainMessage)

      if (videoUrl) {
        await session.send(h.video(videoUrl))
      }

      return
    } catch (error) {
      const detail = error instanceof Error ? error.stack || error.message : String(error)
      logger.error('贴吧解析过程中发生严重错误！\n' + detail)
      return '解析失败，可能是帖子不存在、前端结构变化或网络问题。请管理员检查后台日志以获取详细错误信息。'
    } finally {
      if (page) {
        await page.close()
        logDebug(logger, config.debugMode, 'Puppeteer 页面已关闭。')
      }
      if (pingerId) {
        try {
          await session.bot.deleteMessage(session.channelId, pingerId)
          logDebug(logger, config.debugMode, '已撤回“正在生成”的提示消息。')
        } catch (error) {
          if (config.debugMode) logger.warn('撤回提示消息失败，可能缺少权限。', error)
        }
      }
    }
  })
}
