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

    REPO_URL="${REPO_URL:-https://github.com/ungerofy-gif/xray-cli.git}"
    REPO_BRANCH="${REPO_BRANCH:-main}"

    if [ -d "$INSTALL_DIR/.git" ]; then
        log_info "Updating existing installation from $REPO_URL..."
        cd "$INSTALL_DIR"

        CURRENT_REMOTE="$(git remote get-url origin 2>/dev/null || true)"
        if [ "$CURRENT_REMOTE" != "$REPO_URL" ]; then
            log_warn "Remote URL mismatch. Replacing origin with: $REPO_URL"
            git remote set-url origin "$REPO_URL"
        fi

        git fetch --prune origin
        git checkout "$REPO_BRANCH" 2>/dev/null || git checkout -b "$REPO_BRANCH" "origin/$REPO_BRANCH"
        git pull --ff-only origin "$REPO_BRANCH" || {
            log_warn "Fast-forward pull failed. Re-cloning clean copy..."
            cd /
            rm -rf "$INSTALL_DIR"
        }
    fi

    if [ ! -d "$INSTALL_DIR/.git" ]; then
        git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR" || {
            log_error "Failed to clone repository: $REPO_URL (branch: $REPO_BRANCH)"
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

install_go_for_bot() {
    local required_major_minor="1.24"
    local required_patch="1.24.0"
    local go_bin="/usr/local/go/bin/go"

    if command -v go &> /dev/null; then
        local installed_version
        installed_version="$(go version | awk '{print $3}' | sed 's/^go//')"
        if [[ "$installed_version" == "$required_major_minor".* ]]; then
            log_info "Go already installed and compatible: go${installed_version}"
            return
        fi
        log_warn "Go version go${installed_version} is not compatible. Installing go${required_patch}..."
    else
        log_step "Installing Go ${required_patch} for Telegram bot build..."
    fi

    local arch
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) arch="amd64" ;;
        aarch64|arm64) arch="arm64" ;;
        *)
            log_error "Unsupported CPU architecture for Go install: ${arch}"
            exit 1
            ;;
    esac

    local tarball="go${required_patch}.linux-${arch}.tar.gz"
    local url="https://go.dev/dl/${tarball}"
    local tmp="/tmp/${tarball}"

    curl -fsSL "$url" -o "$tmp"
    rm -rf /usr/local/go
    tar -C /usr/local -xzf "$tmp"
    rm -f "$tmp"

    if [ ! -x "$go_bin" ]; then
        log_error "Go installation failed"
        exit 1
    fi

    if ! grep -q '/usr/local/go/bin' /etc/profile; then
        echo 'export PATH=/usr/local/go/bin:$PATH' >> /etc/profile
    fi

    export PATH="/usr/local/go/bin:$PATH"
    log_info "Go installed: $($go_bin version)"
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
if [ -f /etc/default/xraycli-api ]; then
  # shellcheck disable=SC1091
  . /etc/default/xraycli-api
fi
PATH="${HOME}/.bun/bin:${PATH}"
exec "$HOME/.bun/bin/bun" run /usr/local/xray-cli/src/api/server.ts "$@"
EOF
    chmod +x /usr/local/bin/xraycli-api

    log_info "Global scripts created: xraycli, xraycli-api"
}

ensure_xraycli_api_env_file() {
    log_step "Ensuring /etc/default/xraycli-api exists and has required variables..."

    local env_file="/etc/default/xraycli-api"
    touch "$env_file"

    ensure_var() {
        local key="$1"
        local value="$2"
        if ! grep -qE "^${key}=" "$env_file"; then
            echo "${key}=${value}" >> "$env_file"
            log_info "Added ${key} to ${env_file}"
        fi
    }

    ensure_var "XRAY_CONFIG_PATH" "/usr/local/etc/xray/config.json"
    ensure_var "API_HOST" "127.0.0.1"
    ensure_var "API_PORT" "2053"
    ensure_var "XRAY_API_ADDRESS" "127.0.0.1:8080"
    ensure_var "XRAY_BIN_PATH" "/usr/local/bin/xray"
    ensure_var "XRAYCLI_DATA_DIR" "/var/lib/xray-cli"
    mkdir -p /var/lib/xray-cli
}

create_xraycli_api_service() {
    log_step "Creating systemd service for xraycli-api..."

    tee /etc/systemd/system/xraycli-api.service > /dev/null << 'EOF'
[Unit]
Description=Xray CLI API Service
After=network.target xray.service
Wants=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/usr/local/xray-cli
EnvironmentFile=-/etc/default/xraycli-api
ExecStart=/usr/local/bin/xraycli-api
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable --now xraycli-api 2>/dev/null || {
        log_warn "Failed to enable/start xraycli-api automatically"
        log_info "Start manually with: systemctl start xraycli-api"
        return
    }

    if systemctl is-active --quiet xraycli-api 2>/dev/null; then
        log_info "xraycli-api service is running"
    else
        log_warn "xraycli-api service is installed but not running"
        log_info "Check logs: journalctl -u xraycli-api -n 100 --no-pager"
    fi
}

install_go_bot_service() {
    log_step "Building and installing xray-telegram-bot service..."

    local bot_dir="$INSTALL_DIR/go-bot"
    local bot_service_src="$bot_dir/deploy/xray-telegram-bot.service"
    local bot_service_dst="/etc/systemd/system/xray-telegram-bot.service"

    if [ ! -d "$bot_dir" ]; then
        log_warn "Go bot directory not found: $bot_dir"
        return
    fi

    if [ ! -f "$bot_service_src" ]; then
        log_warn "Go bot service file not found: $bot_service_src"
        return
    fi

    export PATH="/usr/local/go/bin:$PATH"
    cd "$bot_dir"

    /usr/local/go/bin/go mod tidy
    /usr/local/go/bin/go build -trimpath -ldflags='-s -w' -o "$bot_dir/bin/xray-telegram-bot" ./cmd/bot

    install -m 0644 "$bot_service_src" "$bot_service_dst"

    if [ ! -f /etc/default/xraycli-telegram-bot ]; then
        cat > /etc/default/xraycli-telegram-bot << 'EOF'
TG_BOT_TOKEN=
TG_ALLOWED_USER_IDS=
API_TIMEOUT=10s
METRICS_TIMEOUT=3s
COMMAND_TIMEOUT=20s
USERS_PER_PAGE=8
SYSTEM_ENV_FILE=/etc/default/xraycli-api
EOF
        log_warn "Created /etc/default/xraycli-telegram-bot. Fill TG_BOT_TOKEN and TG_ALLOWED_USER_IDS."
    fi

    systemctl daemon-reload
    systemctl enable xray-telegram-bot
    systemctl restart xray-telegram-bot || {
        log_warn "Failed to start xray-telegram-bot automatically"
        log_info "Check logs: journalctl -u xray-telegram-bot -n 100 --no-pager"
        return
    }

    if systemctl is-active --quiet xray-telegram-bot 2>/dev/null; then
        log_info "xray-telegram-bot service is running"
    else
        log_warn "xray-telegram-bot service is installed but not running"
        log_info "Check logs: journalctl -u xray-telegram-bot -n 100 --no-pager"
    fi
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

    if command -v go &> /dev/null; then
        GO_VERSION=$(go version 2>/dev/null || echo "unknown")
        echo -e "  Go:       ${GREEN}✓${NC} $GO_VERSION"
    else
        echo -e "  Go:       ${RED}✗${NC} Not found"
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

    if [ -f "/etc/systemd/system/xray-telegram-bot.service" ]; then
        echo -e "  TG Bot:   ${GREEN}✓${NC} /etc/systemd/system/xray-telegram-bot.service"
    else
        echo -e "  TG Bot:   ${YELLOW}!${NC} Not installed"
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
    install_go_for_bot
    install_xray_cli_deps
    ensure_xraycli_api_env_file
    create_global_scripts
    create_xraycli_api_service
    install_go_bot_service
    verify_installation
}

main "$@"
