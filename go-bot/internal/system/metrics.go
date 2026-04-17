package system

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/mem"
)

type Metrics struct {
	Cores       int
	CPUPercent  float64
	RAMUsedMB   uint64
	RAMTotalMB  uint64
}

func GetMetrics(ctx context.Context) (Metrics, error) {
	cores, err := cpu.CountsWithContext(ctx, true)
	if err != nil {
		return Metrics{}, fmt.Errorf("cpu cores: %w", err)
	}

	usage, err := cpu.PercentWithContext(ctx, time.Second, false)
	if err != nil {
		return Metrics{}, fmt.Errorf("cpu usage: %w", err)
	}
	vm, err := mem.VirtualMemoryWithContext(ctx)
	if err != nil {
		return Metrics{}, fmt.Errorf("ram: %w", err)
	}

	cpuValue := 0.0
	if len(usage) > 0 {
		cpuValue = usage[0]
	}

	return Metrics{
		Cores:      cores,
		CPUPercent: cpuValue,
		RAMUsedMB:  vm.Used / 1024 / 1024,
		RAMTotalMB: vm.Total / 1024 / 1024,
	}, nil
}

func RestartXray(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, "systemctl", "restart", "xray")
	if err := cmd.Run(); err != nil {
		details := systemctlDiagnostics(ctx)
		if details != "" {
			return details, err
		}
		return "", err
	}
	return "", nil
}

func systemctlDiagnostics(ctx context.Context) string {
	cmd := exec.CommandContext(ctx, "systemctl", "status", "xray", "--no-pager", "-n", "20")
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return ""
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) > 12 {
		lines = lines[len(lines)-12:]
	}
	return strings.Join(lines, "\n")
}
