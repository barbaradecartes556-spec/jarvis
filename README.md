# J.A.R.V.I.S.

版本：v1.9.2（opus5.5版）

当前项目保存自 `jarvis-v1.9.2（opus5.5版）`。

使用方式请查看 [使用说明](使用说明.md)。

- macOS：打开 `启动贾维斯.command`。
- Windows：打开 `启动贾维斯.bat`。
- 手动启动：运行 `python3 server.py`，用 Chrome 打开 http://localhost:8765 。

API Key 和语音 Token 保存在本机的 `~/Jarvis/config.json` 中；也支持通过 `JARVIS_CONFIG` 指定配置路径。示例见 `config.example.json`。

`.gitignore` 已排除真实的 `config.json`、配置备份、`.env` 文件及常见密钥文件。不要把真实密钥填入示例文件或源代码。
