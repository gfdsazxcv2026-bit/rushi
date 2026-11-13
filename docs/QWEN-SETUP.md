# 通义千问本机配置

2026-10-29：用户已改用 `qwen3.5-omni-plus`，沿用本机相同Chat Completions地址和密钥。当前配置不发送思考参数，显式 `modalities=["text"]`；角色JSON继续由提示和服务端校验保证，不依赖原生response_format。一次真实短连接及一条廷尉李斯回复均已完成，59项相关自动化通过。仅说明本次接入可用，不把旧模型的八场景验收继承给新模型。下文3.8记录为历史证据。

已选择阿里云百炼作为提供商。2026-10-27按用户指定使用 `qwen3.8-omni-flash`、`system`、`max_completion_tokens`、`enable_thinking=false`。本机配置已通过一次真实连接探测、完整对话和Chrome操作；人物效果另有未通过案例，见 `DEMO2-LIVE-VALIDATION.md`。其他账号仍需自行确认地域、权限与配置，连接成功不代表内容验收通过。

已核对该模型支持文本输入、文本输出和Chat Completions流式调用；默认开启思考，本预设显式关闭。无需为现有文字聊天增加音视频输入或语音播放。官方也提供 `reasoning_effort=none` 关闭思考的方式，本配置按兼容接口文档使用 `enable_thinking=false`，不同时设置多个思考控制参数。

输出长度使用可配置的 `max_completion_tokens`。通用兼容文档未在支持列表单独列出该Omni型号，专用示例也未明确此参数；本轮真实探测与后续流式调用已接受当前组合并返回文本。这证明本账号本次调用成功，不推导其他型号或账号同样可用，也未独立验证供应商内部如何计算该上限。不会自动换参数反复请求。

## 在电脑上完成

1. 打开[百炼API Key页面](https://bailian.console.aliyun.com/?tab=globalset#/efm/api_key)，确认所用地域，在API Key/业务空间界面复制API Host。不同地域的API Host、API Key和可用模型不能混用。
2. 在项目目录双击 `configure-qwen.cmd`。先填写API Host（或完整兼容Base URL），然后在隐藏输入中填写API Key。工具只保存本地 `.env`，不发送模型请求；不要把密钥发到聊天里。
3. 填写后双击 `check-model.cmd` 做静态检查。再由开发协作者执行一次实际连接、小批真实对话和浏览器验收。配置保存不自动重启服务，原网站继续使用当前已加载模式，原有记录保留。

API Host示例形态：`https://业务空间ID.cn-beijing.maas.aliyuncs.com`，工具自动补 `/compatible-mode/v1`。请复制控制台真实值，不照抄示例中的中文。已用旧DashScope域名的账号也可填写其官方兼容地址。阿里云建议使用业务空间专属域名，现有域名仍可使用。

如果需要指定账号实际可用模型，可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\configure-qwen.ps1 -Model 模型名`；这不会为账号开通尚无权限的模型。非混合思考模型或较早型号需要重新核对参数，请使用通用配置而非盲目沿用本预设。

## 验证顺序

静态配置检查 → 一次最多256 tokens/15秒且不自动重试的真实连接探测 → 重启本机服务加载配置 → D08/D09/D11最多6次聊天提交 → 人工检查实际回复 → 其余22例分批 → 真实浏览器验收。只有实际执行的部分才记录通过；没有密钥时保持待验证。服务端的一次可重试故障可能增加供应商尝试次数，具体用量需结合供应商账单。

## 核对的官方资料

- [获取与配置API Key](https://help.aliyun.com/zh/model-studio/get-api-key)：地域、API Host与密钥获取。
- [地域与接入域名](https://help.aliyun.com/zh/model-studio/regions)：业务空间域名、旧域名与地域对应。
- [Chat兼容接口](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)：system、SSE、max_completion_tokens和关闭思考的顶层参数。
- [选择模型](https://help.aliyun.com/zh/model-studio/models)：模型列表；实际可用性与价格以账号所在地域控制台为准。
- [用户指定模型](https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash)与[Omni调用指南](https://help.aliyun.com/zh/model-studio/qwen-omni)：文本输出、Chat Completions和思考参数。实际可用性与价格以账号所在地域控制台为准。

## alpha.3 输出与采样预设

configure-qwen新增role-json、temperature=0.3、presence_penalty=0。通用configure-model在未明确指定这些可选项时保留已有设置。千问JSON对象模式已用本机真实账号获得完整角色回答；[官方Omni指南](https://help.aliyun.com/zh/model-studio/qwen-omni)提供response_format={type:"json_object"}用法。程序先缓存原始JSON、核对后才向页面分段返回可读文本，不展示原始JSON。角色格式、引用、语气与网络故障共用最多一次修订预算，停止/超时不增加隐藏循环。静态检查通过不代表实际语义通过，见[当前复测](VALIDATION.md)。

当前模型后续验收已完成，具体范围和保留项见[新模型验收](VALIDATION.md)，此前切换时仅一条李斯样例的说明保留为历史记录。
