#!/bin/bash
# Unity Reverse Engineering Environment Check Script
# Verifies all dependencies and tools are properly configured

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "=========================================="
echo "Unity Reverse Engineering Environment Check"
echo "=========================================="
echo ""

ERRORS=0
WARNINGS=0

# Function to check command
check_command() {
    local cmd=$1
    local name=$2
    local install_hint=$3
    
    if command -v $cmd &> /dev/null; then
        echo -e "${GREEN}✓${NC} $name: $(which $cmd)"
        return 0
    else
        echo -e "${RED}✗${NC} $name: Not found"
        if [ ! -z "$install_hint" ]; then
            echo "   Install: $install_hint"
        fi
        ERRORS=$((ERRORS + 1))
        return 1
    fi
}

# Function to check file
check_file() {
    local file=$1
    local name=$2
    
    if [ -f "$file" ]; then
        echo -e "${GREEN}✓${NC} $name: $file"
        return 0
    else
        echo -e "${RED}✗${NC} $name: Not found at $file"
        ERRORS=$((ERRORS + 1))
        return 1
    fi
}

# Function to check directory
check_dir() {
    local dir=$1
    local name=$2
    
    if [ -d "$dir" ]; then
        echo -e "${GREEN}✓${NC} $name: $dir"
        return 0
    else
        echo -e "${YELLOW}⚠${NC} $name: Not found at $dir"
        WARNINGS=$((WARNINGS + 1))
        return 1
    fi
}

echo "📋 REQUIRED DEPENDENCIES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check .NET SDK
check_command dotnet ".NET SDK" "brew install dotnet (macOS) or see https://dotnet.microsoft.com/download"
if command -v dotnet &> /dev/null; then
    DOTNET_VERSION=$(dotnet --version)
    echo "   Version: $DOTNET_VERSION"
fi

# Check unzip
check_command unzip "unzip" "brew install unzip (macOS) or apt-get install unzip (Linux)"

# Check curl
check_command curl "curl" "Should be pre-installed"

# Check jq
check_command jq "jq" "brew install jq (macOS) or apt-get install jq (Linux)"

echo ""
echo "🔑 API CONFIGURATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check Anthropic API Key
if [ ! -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${GREEN}✓${NC} ANTHROPIC_API_KEY: Set (${#ANTHROPIC_API_KEY} chars)"
else
    echo -e "${RED}✗${NC} ANTHROPIC_API_KEY: Not set"
    echo "   Set it: export ANTHROPIC_API_KEY='sk-ant-...'"
    echo "   Add to ~/.zshrc or ~/.bashrc to persist"
    ERRORS=$((ERRORS + 1))
fi

echo ""
echo "🛠️  UNITY REVERSE TOOLS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check Il2CppDumper
DUMPER_PATH="./packages/opencode/unity-reverse-tools/external/Il2CppDumper/Il2CppDumper/bin/Release/net6.0/Il2CppDumper"
if check_file "$DUMPER_PATH" "Il2CppDumper binary"; then
    # Try to run it
    if "$DUMPER_PATH" --help &> /dev/null; then
        echo "   Status: Working"
    else
        echo -e "${YELLOW}⚠${NC}  Status: Binary exists but may not work"
        WARNINGS=$((WARNINGS + 1))
    fi
else
    echo "   Build it: cd packages/opencode/unity-reverse-tools/scripts && ./setup-il2cppdumper.sh"
fi

# Check OpenCode tools
echo ""
echo "📦 OPENCODE TOOLS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

TOOLS=(
    "unity-unpack"
    "unity-dump"
    "unity-target-finder"
    "unity-reverse"
    "unity-validate"
    "unity-workflow-orchestrator"
)

for tool in "${TOOLS[@]}"; do
    check_file ".opencode/tool/${tool}.ts" "$tool"
done

# Check agent
check_file ".opencode/agent/reverse-execute.md" "reverse-execute agent"

# Check skill
check_dir ".opencode/skills/unity-reverse-workflow" "unity-reverse-workflow skill"

echo ""
echo "⭐ OPTIONAL TOOLS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check IDA Pro
IDA_PATHS=(
    "/Applications/IDA Pro 8.3/ida64.app/Contents/MacOS/ida64"
    "/Applications/IDA Pro 8.4/ida64.app/Contents/MacOS/ida64"
    "/Applications/IDA Pro/ida64.app/Contents/MacOS/ida64"
    "/usr/local/bin/ida64"
)

IDA_FOUND=false
for ida_path in "${IDA_PATHS[@]}"; do
    if [ -f "$ida_path" ]; then
        echo -e "${GREEN}✓${NC} IDA Pro: $ida_path"
        IDA_FOUND=true
        break
    fi
done

if [ "$IDA_FOUND" = false ]; then
    echo -e "${YELLOW}⚠${NC} IDA Pro: Not found (optional, adds 10-15% accuracy)"
    echo "   Accuracy without IDA: ~70-75%"
    echo "   Accuracy with IDA: ~85-90%"
    WARNINGS=$((WARNINGS + 1))
fi

# Check Unity Editor
UNITY_PATHS=(
    "/Applications/Unity/Hub/Editor/2021.3"
    "/Applications/Unity/Hub/Editor/2022.3"
    "/Applications/Unity/Hub/Editor"
)

UNITY_FOUND=false
for unity_path in "${UNITY_PATHS[@]}"; do
    if [ -d "$unity_path" ]; then
        echo -e "${GREEN}✓${NC} Unity Editor: $unity_path"
        UNITY_FOUND=true
        break
    fi
done

if [ "$UNITY_FOUND" = false ]; then
    echo -e "${YELLOW}⚠${NC} Unity Editor: Not found (optional, for DLL references)"
    echo "   Install Unity Hub for better validation"
    WARNINGS=$((WARNINGS + 1))
fi

echo ""
echo "=========================================="
echo "SUMMARY"
echo "=========================================="

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✓ All checks passed!${NC}"
    echo ""
    echo "You're ready to reverse engineer Unity games!"
    echo ""
    echo "Try: opencode \"Reverse engineer ./MyGame.apk\""
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠ Passed with $WARNINGS warning(s)${NC}"
    echo ""
    echo "You can proceed, but consider installing optional tools for better results."
    echo ""
    echo "Try: opencode \"Reverse engineer ./MyGame.apk\""
    exit 0
else
    echo -e "${RED}✗ $ERRORS error(s), $WARNINGS warning(s)${NC}"
    echo ""
    echo "Please fix the errors above before proceeding."
    echo ""
    echo "Quick fixes:"
    echo "1. Install .NET SDK: brew install dotnet"
    echo "2. Build Il2CppDumper: cd packages/opencode/unity-reverse-tools/scripts && ./setup-il2cppdumper.sh"
    echo "3. Set API key: export ANTHROPIC_API_KEY='sk-ant-...'"
    exit 1
fi
