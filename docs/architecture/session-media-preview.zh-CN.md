<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# ACP 会话媒体发布

ACP 的 image、resource_link 和 embedded resource 通过 `PluginExecutorContext.publishMedia` 交给 Host，复用 `ChatImageDeliveryService` 的读取边界、联网策略、校验、队列、配额和 Artifact 保存。媒体格式由 Host 校验器决定；本变更沿用 PNG/JPEG/GIF/WebP 支持，SVG 格式与预览由独立变更承接。图片输出只携带当前 Session 的 Artifact 引用，不把 base64 写进消息事件。

正文结构化图片转为 `maka://runtime/attachments/<artifactId>` Markdown 引用。工具结果新增有序 `content.parts`，支持文本、已保存图片和 diff；旧 text/file_diff/image 保持可读。旧客户端无法解码新结果，兼容 epoch 从 229 升至 230，合并前需对照 main 确认。

通用复制层收集并重写混合内容的图片引用；ACP 会话仍受既有 provider-owned conversation cloning 限制，本变更不开放外部执行器会话复制。CLI 按顺序输出描述；没有媒体发布能力或发布失败时返回有界文字提示。

通知接收时完成准入并绑定当前轮次，串行处理以保留到达顺序。取消或断连中断媒体等待，但收尾已收到的文字和工具结果；prompt 返回后仍检测断连直至队列排空，迟到通知和媒体完成不会写回已结束轮次。慢图片归档会延迟后续文字，应在端到端验收中观察。

Host 最多 2 个并行捕获、128 个任务，内联字节最多 8 MiB，单图片最多 2 MiB。ACP 按唯一媒体计数和累计字节限制每轮保留内容，audio 计入预算，非文本 thought 入队前丢弃。重复工具快照复用媒体对象；纯文本和纯 diff 沿用旧规则，混合结果最多 64 项，超出明确提示省略。

验证覆盖媒体投影、真实 MIME、配额和网络失败、源文件删除后的归档回放、会话复制，以及取消和断连时的顺序与收尾。SVG 文件和代码块预览独立验收。
