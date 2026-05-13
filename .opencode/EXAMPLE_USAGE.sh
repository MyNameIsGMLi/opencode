#!/bin/bash
# Unity Reverse Engineering - Example Usage
# 这个脚本展示了如何使用Unity逆向工程工具链

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Unity Reverse Engineering - 使用示例"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "示例 1: 最简单的用法"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo 'opencode "Reverse engineer ./MyGame.apk"'
echo ""

echo "示例 2: 指定输出目录"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo 'opencode "Reverse ./MyGame.apk to ./my_project"'
echo ""

echo "示例 3: 禁用IDA分析（更快）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo 'opencode "Reverse ./MyGame.apk without IDA analysis"'
echo ""

echo "示例 4: 指定Unity版本"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo 'opencode "Reverse ./MyGame.apk using Unity 2022.3"'
echo ""

echo "示例 5: XAPK文件（带OBB）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo 'opencode "Reverse ./BigGame.xapk"'
echo ""

echo "示例 6: iOS IPA文件"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo 'opencode "Reverse ./iOSGame.ipa"'
echo ""

echo "示例 7: 使用工作流编排器（高级）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
cat << 'EXAMPLE'
opencode "Use unity-workflow-orchestrator:
- inputFile: ./game.apk
- outputDir: ./reversed
- enableIda: true
- batchSize: 50
- maxRetries: 3"
EXAMPLE
echo ""

echo "示例 8: 分步执行（手动控制）"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo '# 步骤1: 解包'
echo 'opencode "Use unity-unpack on ./game.apk"'
echo ''
echo '# 步骤2: 提取元数据'
echo 'opencode "Use unity-dump on binary and metadata from extracted files"'
echo ''
echo '# 步骤3: 识别目标'
echo 'opencode "Use unity-target-finder on ./dump.cs"'
echo ''
echo '# 步骤4: 逆向特定类'
echo 'opencode "Use unity-reverse on Game.Player.PlayerController"'
echo ''
echo '# 步骤5: 验证'
echo 'opencode "Use unity-validate on ./reversed/*.cs"'
echo ""

echo "示例 9: 监控进度"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo '# 在另一个终端窗口运行：'
echo 'tail -f *_reversed/workflow.log'
echo ""

echo "示例 10: 检查结果"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo '# 查看报告'
echo 'cat MyGame_reversed/REVERSE_REPORT.md'
echo ''
echo '# 查看生成的代码'
echo 'ls MyGame_reversed/reversed/'
echo ''
echo '# 检查成功率'
echo 'grep "Success Rate" MyGame_reversed/REVERSE_REPORT.md'
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💡 提示："
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. 首次使用前运行环境检查："
echo "   .opencode/scripts/check-unity-reverse-env.sh"
echo ""
echo "2. 确保设置了API密钥："
echo '   export ANTHROPIC_API_KEY="sk-ant-..."'
echo ""
echo "3. 查看完整文档："
echo "   cat .opencode/UNITY_REVERSE_README.md"
echo ""
echo "4. 快速开始指南："
echo "   cat .opencode/UNITY_REVERSE_QUICKSTART.md"
echo ""
