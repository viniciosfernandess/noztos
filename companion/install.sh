#!/usr/bin/env bash
# Bornastar companion installer
# Usage: curl -fsSL https://bornastar.com/install.sh | bash

set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${BOLD}  ⚡ Bornastar Companion Installer${NC}"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo -e "  ${RED}✗${NC} Node.js is required (v18+). Install it first:"
  echo -e "    ${CYAN}https://nodejs.org${NC}"
  echo ""
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "  ${RED}✗${NC} Node.js v18+ is required (found v${NODE_VERSION})"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# Check Claude Code
if command -v claude &> /dev/null; then
  echo -e "  ${GREEN}✓${NC} Claude Code installed"
else
  echo -e "  ${YELLOW}!${NC} Claude Code not found. Install it:"
  echo -e "    ${CYAN}curl -fsSL https://claude.ai/install.sh | bash${NC}"
  echo ""
fi

# Install companion globally
echo ""
echo -e "  Installing @bornastar/companion..."
npm install -g @bornastar/companion@latest 2>/dev/null || {
  echo -e "  ${YELLOW}!${NC} Global npm install failed. Trying with sudo..."
  sudo npm install -g @bornastar/companion@latest
}

echo ""
echo -e "  ${GREEN}✓${NC} Bornastar companion installed!"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo ""
echo -e "  1. Authenticate:  ${CYAN}bornastar login <token>${NC}"
echo -e "     (Get your token from bornastar.com/settings)"
echo ""
echo -e "  2. Register a project:  ${CYAN}cd ~/your-project && bornastar init${NC}"
echo ""
echo -e "  3. Start the daemon:  ${CYAN}bornastar start${NC}"
echo ""
echo -e "  4. Open ${CYAN}bornastar.com${NC} and start coding!"
echo ""
