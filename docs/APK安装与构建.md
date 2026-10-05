# 自考星 · Android APK 安装与构建

> 独立运行的安卓 App：**爬虫和数据库都在手机里，不需要连电脑、不需要开服务**

---

## 一、拿到 APK 装到手机

APK 位置：`zikao-app/zikao.apk`

**安装步骤**
1. 把 `zikao.apk` 传到手机（微信/QQ 传文件、数据线、网盘都行）
2. 手机上点这个文件
3. 提示「是否允许安装未知来源应用」→ **点允许**（这是自签名调试包，不是应用商店版本）
4. 装完桌面上会出现 🌸 自考星图标

**iPhone 用户看这里** → [iOS 安装说明](#iphone-怎么办)

---

## 二、APK 有什么特点

| 项目 | 说明 |
|------|------|
| **完全独立** | 爬虫在手机 WebView 里跑，数据存手机本地，**不需要电脑** |
| 抓取时机 | 每次打开 App 自动抓一轮；首页 🔄 可手动触发 |
| 数据存储 | localStorage（成绩/状态）+ IndexedDB（资讯正文），都在手机里 |
| 离线可用 | 已抓的资讯和你的成绩断网也能看 |
| 权限 | 联网、通知（考前提醒） |
| 数据互通 | ❌ 与 PC 端**不互通**，各有独立数据库（设置里可导出/导入 JSON） |

**两种模式怎么选**

- **手机端**：随手查、随身带，打开就抓一次。适合大多数场景
- **PC 端**：可以跑守护进程全天自动抓 + 定时提醒。适合放家里当"信息中枢"

---

## 三、自己重新构建（可选）

### 需要先装两样东西（一次性约 600MB）

**① JDK 17**

国内直接下载 GitHub 极慢，用华为云镜像：

```bash
curl -L -o jdk17.zip "https://mirrors.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip"
```

解压后设置环境变量：
```
JAVA_HOME = <解压目录>/jdk-17.0.2
PATH 追加  %JAVA_HOME%/bin
```

**② Android SDK 命令行工具**

```bash
curl -L -o cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
```

解压后**目录结构必须是这样**（注意有两层 cmdline-tools）：
```
android-sdk/
  cmdline-tools/
    cmdline-tools/
      bin/sdkmanager.bat     ← 必须在这个位置
```

装组件：
```bash
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

### 国内必须改镜像（否则超时）

**① Gradle 镜像** — `android/gradle/wrapper/gradle-wrapper.properties`
```properties
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.2.1-all.zip
networkTimeout=120000
```

**② Maven 镜像** — `android/build.gradle`

把所有 `google()` 和 `mavenCentral()` 替换为：
```groovy
maven { url 'https://maven.aliyun.com/repository/google' }
maven { url 'https://maven.aliyun.com/repository/gradle-plugin' }
maven { url 'https://maven.aliyun.com/repository/central' }
maven { url 'https://maven.aliyun.com/repository/public' }
```

### 构建命令

```bash
cd zikao-app
npm install
node web/make-icons.js                        # 生成图标
npx cap sync android                          # 同步 web 资源
cd android
./gradlew assembleDebug
```

**产物**：`android/app/build/outputs/apk/debug/app-debug.apk`

---

## 四、常见问题

**Q：装不上，提示"应用未安装"**
A：手机设置里允许「安装未知来源应用」。国产手机（小米/华为/OPPO）通常在「设置 → 安全 → 未知来源应用安装」里，要给文件管理器或浏览器开权限。

**Q：装上了但打开是白屏**
A：多半是资源没同步。执行 `npx cap sync android` 后重新构建。

**Q：抓不到资讯 / 资讯是空的**
A：APK 首次打开会自动抓一轮，需要 10-30 秒。如果一直空：
- 检查手机能不能上网
- 部分校园网/公司网会拦截 gov.cn 域名，换网络试试

**Q：数据会丢吗？**
A：卸载 App 或清除数据会丢。建议偶尔在设置里导出 JSON 备份。

**Q：能同时装在手机和电脑吗？**
A：能，但数据不互通。PC 端和手机端各存各的。

---

## iPhone 怎么办

苹果**强制要求** iOS App 必须用 macOS + Xcode 签名打包，Windows 上没有任何合法途径绕过。

**推荐做法（PWA，1 分钟搞定）**

1. 电脑上双击 `启动.bat`
2. iPhone 和电脑连**同一个 WiFi**
3. iPhone 用 **Safari** 打开命令行里显示的 `http://192.168.x.x:5173`
4. 点底部**分享按钮**（方框↑）→ **添加到主屏幕**

桌面上就有 🌸 图标，点开是全屏的、没有地址栏，日常用起来和原生 App 几乎没区别，还不用签名、不用审核、随时能改代码。

**想要真正的 iOS App？** 你需要有台 Mac，然后：
```bash
cd zikao-app
npm install
npx cap add ios
npx cap sync ios
npx cap open ios
```
Xcode 里选 `App` target → Signing 勾上 Automatically manage signing → Team 选你的 Apple ID → 改 Bundle ID → 点运行。

或者用仓库里的 `.github/workflows/build-apk.yml`，Actions 跑一次会同时出 Android 和 iOS 两个产物。

---

_自考星 v1.0 · 2026-10-03_
