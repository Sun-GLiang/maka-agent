/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { UiLocale, UiCatalog } from '@maka/core/ui-locale';
import type { ExternalAgentSetupFailure } from '@maka/runtime-host/protocol';
const en = {
  title: 'Antigravity',
  accountUnchecked: 'Sign-in has not been verified. Sign in with Google to continue.',
  accountBeforeSave: 'Configure the program connection above before signing in.',
  googleAccount: 'Sign-in status',
  accountDescription: 'Sign-in opens in your browser. Antigravity manages your credentials.',
  accountTitle: 'Google account',
  connectionVerified: 'Connection successful.',
  connectionBeforeSave: 'Save the program path first, then check whether Maka can connect.',
  connectionStatus: 'Connection status',
  invalidPath:
    'Enter an absolute path starting with /, without control characters (up to 4,096 characters).',
  downloadAcp: 'Download official ACP 1.1.1 for macOS Apple Silicon',
  pathHelp:
    'Unzip the official distribution and paste the absolute path to agy_acp_server.par. Keep localharness_external in the same folder.',
  setupHelp:
    'The Antigravity desktop app alone is not enough. Download the separate official ACP distribution, then save its program path below.',
  setupHelpTitle: 'Set up the Antigravity connection',
  changePath: 'Change',
  setPath: 'Set up',
  notConfigured: 'Not configured',
  catalogTitle: 'Available agents',
  catalogDescription: 'Choose an external agent to configure its connection and sign in.',
  agentDescription: 'Google’s coding agent, connected through the official ACP distribution.',
  configured: 'Configured',
  setupTitle: 'Connection',
  backToAgents: 'Back to external agents',
  description:
    'Use a separately installed official ACP distribution with its matching helper. Google credentials are managed by Antigravity.',
  executable: 'Program path',
  save: 'Save',
  check: 'Check connection',
  login: 'Sign in with Google',
  cancel: 'Cancel',
  retry: 'Retry',
  loading: 'Checking availability…',
  unavailable: 'Available on local macOS Apple Silicon Hosts only.',
  unconfigured: 'Save the absolute path to agy_acp_server.par to get started.',
  unchecked: 'Connection and sign-in have not been verified.',
  unsaved: 'Save this path before checking or signing in.',
  connecting: 'Connecting…',
  awaiting_authorization: 'Complete Google sign-in in your browser.',
  cancelling: 'Cancelling and releasing the process…',
  connected: 'Connection successful. Sign-in has not been verified.',
  authenticated: 'Google sign-in completed.',
  cancelled: 'Setup cancelled.',
  error: 'The operation failed. Check the saved path and Host connection, then retry.',
  failures: {
    executable_unavailable:
      'The executable is missing or cannot run. Check the saved path and executable permissions.',
    helper_unavailable:
      'The matching localharness_external helper is missing or cannot run. Keep the official distribution together.',
    connection_failed:
      'ACP connection failed. Check that the executable and helper belong to the same official distribution.',
    authentication_unavailable: 'This agent does not offer the supported Google sign-in method.',
    authentication_failed: 'Antigravity could not complete sign-in. Retry Google sign-in.',
    account_ineligible:
      'Antigravity rejected account eligibility. Check official account and regional availability.',
    browser_failed:
      'The sign-in link could not be opened. Cancel other sign-in attempts and retry.',
    timed_out: 'Setup timed out and its process was stopped. Retry when ready.',
    cleanup_failed: 'The process could not be released. Restart the Host before retrying.',
  } satisfies Record<ExternalAgentSetupFailure, string>,
};
const zh = {
  title: 'Antigravity',
  accountUnchecked: '登录状态尚未验证，使用 Google 登录后继续。',
  accountBeforeSave: '请先完成上方的程序连接配置，再登录。',
  googleAccount: '登录状态',
  accountDescription: '登录将在浏览器中完成，凭据由 Antigravity 管理。',
  accountTitle: 'Google 账号',
  connectionVerified: '连接成功。',
  connectionBeforeSave: '先保存程序路径，再检查 Maka 能否连接。',
  connectionStatus: '连接状态',
  invalidPath: '请填写以 / 开头的绝对路径，不含控制字符，最多 4,096 个字符。',
  downloadAcp: '下载官方 ACP 1.1.1（macOS Apple Silicon）',
  pathHelp:
    '解压官方程序包，填写 agy_acp_server.par 的绝对路径。请将 localharness_external 保留在同一文件夹中。',
  setupHelp: '仅安装 Antigravity 桌面应用还不够。请单独下载官方 ACP 程序，再在下方保存程序路径。',
  setupHelpTitle: '先配置 Antigravity 连接',
  changePath: '更改',
  setPath: '配置',
  notConfigured: '未配置',
  catalogTitle: '可用 Agent',
  catalogDescription: '选择外部 Agent，配置连接并登录。',
  agentDescription: 'Google 编程 Agent，通过官方 ACP 程序连接。',
  configured: '已配置',
  setupTitle: '连接',
  backToAgents: '返回外部 Agent',
  description: '使用单独安装的官方 ACP 程序及其匹配 helper。Google 凭据由 Antigravity 管理。',
  executable: '程序路径',
  save: '保存',
  check: '检查连接',
  login: '使用 Google 登录',
  cancel: '取消',
  retry: '重试',
  loading: '正在检查可用性…',
  unavailable: '仅支持本地 macOS Apple Silicon Host。',
  unconfigured: '保存 agy_acp_server.par 的绝对路径后开始。',
  unchecked: '连接和登录状态尚未验证。',
  unsaved: '请先保存此路径，再检查连接或登录。',
  connecting: '正在连接…',
  awaiting_authorization: '请在浏览器中完成 Google 登录。',
  cancelling: '正在取消并释放进程…',
  connected: '连接成功，登录状态尚未验证。',
  authenticated: 'Google 登录已完成。',
  cancelled: '已取消设置操作。',
  error: '操作失败，请检查已保存路径和 Host 连接后重试。',
  failures: {
    executable_unavailable: '可执行文件不存在或无法运行，请检查已保存路径及执行权限。',
    helper_unavailable: '匹配的 localharness_external 缺失或无法运行，请保留完整的官方分发目录。',
    connection_failed: 'ACP 连接失败，请确认程序和 helper 来自同一官方分发版本。',
    authentication_unavailable: '此程序未提供受支持的 Google 登录方式。',
    authentication_failed: 'Antigravity 未能完成认证，请重试 Google 登录。',
    account_ineligible: 'Antigravity 拒绝了账号资格。请检查官方账号及地区可用性。',
    browser_failed: '无法打开登录链接，请取消其他登录操作后重试。',
    timed_out: '操作超时，已停止临时进程。准备好后可重试。',
    cleanup_failed: '无法释放临时进程，请重启 Host 后重试。',
  } satisfies Record<ExternalAgentSetupFailure, string>,
};
const zhTW: typeof en = {
  title: 'Antigravity',
  accountUnchecked: '登入狀態尚未驗證，使用 Google 登入後繼續。',
  accountBeforeSave: '請先完成上方的程式連線設定，再登入。',
  googleAccount: '登入狀態',
  accountDescription: '登入將在瀏覽器中完成，憑證由 Antigravity 管理。',
  accountTitle: 'Google 帳號',
  connectionVerified: '連線成功。',
  connectionBeforeSave: '先儲存程式路徑，再檢查 Maka 能否連線。',
  connectionStatus: '連線狀態',
  invalidPath: '請填寫以 / 開頭的絕對路徑，不含控制字元，最多 4,096 個字元。',
  downloadAcp: '下載官方 ACP 1.1.1（macOS Apple Silicon）',
  pathHelp:
    '解壓縮官方程式套件，填寫 agy_acp_server.par 的絕對路徑。請將 localharness_external 保留在同一資料夾中。',
  setupHelp:
    '僅安裝 Antigravity 桌面應用程式還不夠。請另外下載官方 ACP 程式，再於下方儲存程式路徑。',
  setupHelpTitle: '先設定 Antigravity 連線',
  changePath: '更改',
  setPath: '設定',
  notConfigured: '未設定',
  catalogTitle: '可用 Agent',
  catalogDescription: '選擇外部 Agent，設定連線並登入。',
  agentDescription: 'Google 程式開發 Agent，透過官方 ACP 程式連線。',
  configured: '已設定',
  setupTitle: '連線',
  backToAgents: '返回外部 Agent',
  description: '使用另外安裝的官方 ACP 程式及其相符的 helper。Google 憑證由 Antigravity 管理。',
  executable: '程式路徑',
  save: '儲存',
  check: '檢查連線',
  login: '使用 Google 登入',
  cancel: '取消',
  retry: '重試',
  loading: '正在檢查可用性…',
  unavailable: '僅支援本機 macOS Apple Silicon Host。',
  unconfigured: '儲存 agy_acp_server.par 的絕對路徑後開始。',
  unchecked: '連線與登入狀態尚未驗證。',
  unsaved: '請先儲存此路徑，再檢查連線或登入。',
  connecting: '正在連線…',
  awaiting_authorization: '請在瀏覽器中完成 Google 登入。',
  cancelling: '正在取消並釋放程序…',
  connected: '連線成功，登入狀態尚未驗證。',
  authenticated: 'Google 登入已完成。',
  cancelled: '已取消設定操作。',
  error: '操作失敗，請檢查已儲存路徑和 Host 連線後重試。',
  failures: {
    executable_unavailable: '執行檔不存在或無法執行，請檢查已儲存路徑及執行權限。',
    helper_unavailable: '相符的 localharness_external 缺失或無法執行，請保留完整的官方分發目錄。',
    connection_failed: 'ACP 連線失敗，請確認程式與 helper 來自同一官方分發版本。',
    authentication_unavailable: '此程式未提供受支援的 Google 登入方式。',
    authentication_failed: 'Antigravity 未能完成驗證，請重試 Google 登入。',
    account_ineligible: 'Antigravity 拒絕了帳號資格。請檢查官方帳號及地區可用性。',
    browser_failed: '無法開啟登入連結，請取消其他登入操作後重試。',
    timed_out: '操作逾時，已停止暫時程序。準備好後可重試。',
    cleanup_failed: '無法釋放暫時程序，請重新啟動 Host 後重試。',
  },
};
const catalog = { en, 'zh-CN': zh, 'zh-TW': zhTW } satisfies UiCatalog<typeof en>;
export function getExternalAgentsCopy(locale: UiLocale) {
  return catalog[locale];
}
