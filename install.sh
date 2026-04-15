#!/bin/bash

set -e

BUN_PATH="$HOME/.bun/bin/bun"
BUN_INSTALL="$HOME/.bun"
INSTALL_DIR="/usr/local/xray-cli"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "This script must be run as root"
        log_info "Run with: sudo $0"
        exit 1
    fi
}

detect_os() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS="$ID"
    elif [ -f /etc/redhat-release ]; then
        OS="rhel"
    elif [ -f /etc/debian_version ]; then
        OS="debian"
    else
        log_error "Cannot detect OS"
        exit 1
    fi
    
    OS_LOWER=$(echo "$OS" | tr '[:upper:]' '[:lower:]')
    
    case "$OS_LOWER" in
        ubuntu|debian|linuxmint|pop)
            PKG_MGR="apt"
            ;;
        centos|rhel|rocky|alma|fedora)
            PKG_MGR="yum"
            ;;
        alpine)
            PKG_MGR="apk"
            ;;
        arch|manjaro|artix)
            PKG_MGR="pacman"
            ;;
        *)
            log_error "Unsupported OS: $OS"
            exit 1
            ;;
    esac
    
    log_info "Detected OS: $OS (package manager: $PKG_MGR)"
}

update_system() {
    log_step "Updating system packages..."
    
    case "$PKG_MGR" in
        apt)
            apt update -y
            apt upgrade -y
            ;;
        yum)
            yum update -y
            ;;
        apk)
            apk update
            apk upgrade
            ;;
        pacman)
            pacman -Sy --noconfirm
            ;;
    esac
}

install_deps() {
    log_step "Installing dependencies..."
    
    case "$PKG_MGR" in
        apt)
            apt install -y curl wget git unzip jq sudo
            ;;
        yum)
            yum install -y curl wget git unzip jq sudo
            ;;
        apk)
            apk add --no-cache curl wget git unzip jq sudo
            ;;
        pacman)
            pacman -Sy --noconfirm curl wget git unzip jq sudo
            ;;
    esac
}

clone_source() {
    log_step "Cloning xray-cli from git..."
    
    REPO_URL="${REPO_URL:-https://github.com/mht-xray/xray-cli.git}"
    
    if [ -d "$INSTALL_DIR/.git" ]; then
        log_info "Updating existing installation..."
        cd "$INSTALL_DIR"
        git fetch origin
        git reset --hard origin/main 2>/dev/null || git reset --hard origin/master 2>/dev/null || {
            log_warn "Update failed, removing and re-cloning..."
            rm -rf "$INSTALL_DIR"
        }
    fi
    
    if [ ! -d "$INSTALL_DIR" ]; then
        git clone "$REPO_URL" "$INSTALL_DIR" || {
            log_error "Failed to clone repository"
            log_info "Make sure the repository exists or set REPO_URL"
            exit 1
        }
    fi
    
    log_info "Source code installed to $INSTALL_DIR"
}

install_xray() {
    log_step "Installing xray-core..."
    
    if command -v xray &> /dev/null; then
        log_info "Xray already installed: $(xray version 2>/dev/null | head -1)"
        return
    fi
    
    bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
    
    log_info "Xray installed successfully"
}

enable_start_xray() {
    log_step "Enabling and starting xray..."
    systemctl enable xray 2>/dev/null || true
    systemctl start xray 2>/dev/null || true
    
    if systemctl is-active --quiet xray 2>/dev/null; then
        log_info "Xray is running"
    else
        log_warn "Xray failed to start. Check: journalctl -u xray"
    fi
}

install_bun() {
    if [ -f "$BUN_PATH" ]; then
        log_info "Bun already installed: $($BUN_PATH --version)"
        return
    fi
    
    log_step "Installing Bun runtime..."
    
    curl -fsSL https://bun.sh/install | bash
    
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    
    if [ -f "$BUN_PATH" ]; then
        log_info "Bun installed: $($BUN_PATH --version)"
    else
        log_error "Bun installation failed"
        exit 1
    fi
}

install_xray_cli_deps() {
    log_step "Installing xray-cli dependencies..."
    
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    
    cd "$INSTALL_DIR"
    
    if [ -f "package.json" ]; then
        timeout 120 "$BUN_PATH" install || {
            log_error "Failed to install dependencies"
            exit 1
        }
    else
        log_error "package.json not found"
        exit 1
    fi
    
    log_info "Dependencies installed"
}

create_global_scripts() {
    log_step "Creating global scripts..."
    
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    mkdir -p /usr/local/bin
    
    tee /usr/local/bin/xraycli > /dev/null << 'EOF'
#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"
export XRAY_CONFIG_PATH="${XRAY_CONFIG_PATH:-/usr/local/etc/xray/config.json}"
exec "$HOME/.bun/bin/bun" run /usr/local/xray-cli/src/index.ts "$@"
EOF
    chmod +x /usr/local/bin/xraycli

    tee /usr/local/bin/xraycli-api > /dev/null << 'EOF'
#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"
export XRAY_CONFIG_PATH="${XRAY_CONFIG_PATH:-/usr/local/etc/xray/config.json}"
export API_PORT="${API_PORT:-2053}"
export API_HOST="${API_HOST:-127.0.0.1}"
exec "$HOME/.bun/bin/bun" run /usr/local/xray-cli/src/api/server.ts "$@"
EOF
    chmod +x /usr/local/bin/xraycli-api

    log_info "Global scripts created: xraycli, xraycli-api"
}

verify_installation() {
    log_step "Verifying installation..."
    
    echo ""
    echo "============================================"
    echo "         Installation Summary"
    echo "============================================"
    echo ""
    
    if command -v xray &> /dev/null; then
        XRAY_VERSION=$(xray version 2>/dev/null | head -1 || echo "unknown")
        echo -e "  Xray:     ${GREEN}✓${NC} $XRAY_VERSION"
    else
        echo -e "  Xray:     ${RED}✗${NC} Not found"
    fi
    
    if [ -f "$BUN_PATH" ]; then
        BUN_VERSION=$($BUN_PATH --version 2>/dev/null || echo "unknown")
        echo -e "  Bun:      ${GREEN}✓${NC} $BUN_VERSION"
    else
        echo -e "  Bun:      ${RED}✗${NC} Not found"
    fi
    
    if [ -f "/usr/local/etc/xray/config.json" ]; then
        echo -e "  Config:   ${GREEN}✓${NC} /usr/local/etc/xray/config.json"
    else
        echo -e "  Config:   ${YELLOW}!${NC} Not found (will be created)"
    fi
    
    if [ -f "/usr/local/bin/xraycli" ]; then
        echo -e "  TUI:      ${GREEN}✓${NC} /usr/local/bin/xraycli"
    else
        echo -e "  TUI:      ${RED}✗${NC} Not found"
    fi
    
    if [ -f "/usr/local/bin/xraycli-api" ]; then
        echo -e "  API:      ${GREEN}✓${NC} /usr/local/bin/xraycli-api"
    else
        echo -e "  API:      ${RED}✗${NC} Not found"
    fi
    
    if systemctl is-active --quiet xray 2>/dev/null; then
        echo -e "  Xray:     ${GREEN}✓${NC} Running"
    else
        echo -e "  Xray:     ${YELLOW}!${NC} Stopped"
    fi
    
    echo ""
    echo "============================================"
    echo -e "       ${GREEN}Installation complete!${NC}"
    echo "============================================"
    echo ""
    echo "Commands:"
    echo "  xraycli          # Start TUI"
    echo "  xraycli-api     # Start API server"
    echo ""
    echo "TUI Menu:"
    echo "  1. Dashboard        - View status and users"
    echo "  2. Profiles        - Manage user profiles"
    echo "  3. Xray Management - Install/update/start/stop xray"
    echo "  4. Settings        - View settings"
    echo "  0. Exit            - Quit"
    echo ""
    echo "API Endpoints:"
    echo "  http://127.0.0.1:2053/<token>  # Subscription"
    echo "  http://127.0.0.1:2053/health    # Health check"
    echo "  http://127.0.0.1:2053/stats     # Traffic stats"
    echo ""
}

main() {
    echo ""
    echo "============================================"
    echo "       xray-cli Installation"
    echo "============================================"
    echo ""
    
    check_root
    detect_os
    update_system
    install_deps
    clone_source
    install_xray
    enable_start_xray
    install_bun
    install_xray_cli_deps
    create_global_scripts
    verify_installation
}

main "$@"