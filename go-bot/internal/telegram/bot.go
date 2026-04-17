package telegram

import (
	"context"
	"fmt"
	"html"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/example/xray-cli-ts/go-bot/internal/config"
	model "github.com/example/xray-cli-ts/go-bot/internal/models"
	"github.com/example/xray-cli-ts/go-bot/internal/service"
	"github.com/example/xray-cli-ts/go-bot/internal/state"
	"github.com/example/xray-cli-ts/go-bot/internal/system"
	botapi "github.com/go-telegram/bot"
	tg "github.com/go-telegram/bot/models"
)

type Handler struct {
	cfg   config.Config
	log   *slog.Logger
	bot   *botapi.Bot
	svc   *service.Service
	store *state.Store
}

func New(_ context.Context, cfg config.Config, svc *service.Service, store *state.Store, logger *slog.Logger) (*Handler, error) {
	h := &Handler{cfg: cfg, log: logger, svc: svc, store: store}
	b, err := botapi.New(cfg.TelegramToken, botapi.WithDefaultHandler(h.onAnyUpdate))
	if err != nil {
		return nil, err
	}
	h.bot = b
	h.registerHandlers()
	return h, nil
}

func (h *Handler) Start(ctx context.Context) {
	h.bot.Start(ctx)
}

func (h *Handler) registerHandlers() {
	h.bot.RegisterHandler(botapi.HandlerTypeMessageText, "/start", botapi.MatchTypeExact, h.onStart)
	for _, prefix := range []string{"sys", "xr", "us", "pg", "ad", "adib", "aex", "acn", "ud", "ut", "ux", "ue", "uig", "uok", "ucn", "bk", "menu"} {
		h.bot.RegisterHandler(botapi.HandlerTypeCallbackQueryData, prefix, botapi.MatchTypePrefix, h.onCallback)
	}
}

func (h *Handler) onAnyUpdate(ctx context.Context, _ *botapi.Bot, upd *tg.Update) {
	if upd.Message != nil && upd.Message.Text != "" {
		h.handleConversationMessage(ctx, upd.Message)
	}
}

func (h *Handler) authorized(userID int64) bool {
	_, ok := h.cfg.AllowedUserIDs[userID]
	return ok
}

func (h *Handler) deny(ctx context.Context, chatID int64) {
	_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{ChatID: chatID, Text: "Доступ запрещен"})
}

func (h *Handler) onStart(ctx context.Context, _ *botapi.Bot, upd *tg.Update) {
	if upd.Message == nil || upd.Message.From == nil {
		return
	}
	if !h.authorized(upd.Message.From.ID) {
		h.deny(ctx, upd.Message.Chat.ID)
		return
	}
	_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{
		ChatID:      upd.Message.Chat.ID,
		Text:        menuText(),
		ParseMode:   tg.ParseModeHTML,
		ReplyMarkup: mainKeyboard(),
	})
}

func mainKeyboard() *tg.InlineKeyboardMarkup {
	return &tg.InlineKeyboardMarkup{InlineKeyboard: [][]tg.InlineKeyboardButton{
		{{Text: "Состояние системы", CallbackData: "sys"}},
		{{Text: "Перезагрузка Xray", CallbackData: "xr"}},
		{{Text: "Пользователи", CallbackData: "us:1"}},
	}}
}

func menuText() string {
	return "🏠 <b>Главное меню</b>\nВыберите действие:"
}

func (h *Handler) onCallback(ctx context.Context, _ *botapi.Bot, upd *tg.Update) {
	if upd.CallbackQuery == nil {
		return
	}
	cq := upd.CallbackQuery
	if !h.authorized(cq.From.ID) {
		h.answerCallback(ctx, cq.ID, "Доступ запрещен")
		return
	}

	parts := strings.Split(cq.Data, ":")
	action := parts[0]

	switch action {
	case "sys":
		h.showSystemState(ctx, cq)
	case "xr":
		h.restartXray(ctx, cq)
	case "us", "pg":
		h.showUsersPage(ctx, cq, parseInt(parts, 1, 1))
	case "ad":
		h.startAddConversation(ctx, cq)
	case "adib":
		h.applyAddInboundsChoice(ctx, cq, parseInt(parts, 1, -1))
	case "aex":
		h.applyAddExpiryChoice(ctx, cq, parseInt(parts, 1, -1))
	case "acn":
		h.cancelAddConversation(ctx, cq)
	case "ud":
		id := parseInt(parts, 1, 0)
		if id > 0 {
			h.showUserDetails(ctx, cq, id)
		}
	case "ut":
		id := parseInt(parts, 1, 0)
		if id > 0 {
			h.toggleUser(ctx, cq, id)
		}
	case "ux":
		id := parseInt(parts, 1, 0)
		if id > 0 {
			h.deleteUser(ctx, cq, id, parseInt(parts, 2, 1))
		}
	case "ue":
		id := parseInt(parts, 1, 0)
		if id > 0 {
			h.startEditUser(ctx, cq, id)
		}
	case "uig":
		if len(parts) >= 2 {
			h.toggleInboundInEdit(ctx, cq, parts[1])
		}
	case "uok":
		h.applyEditUser(ctx, cq)
	case "ucn":
		h.cancelEditUser(ctx, cq)
	case "bk":
		h.showUsersPage(ctx, cq, parseInt(parts, 1, 1))
	case "menu":
		h.showMainMenu(ctx, cq)
	}
	h.answerCallback(ctx, cq.ID, "")
}

func (h *Handler) showMainMenu(ctx context.Context, cq *tg.CallbackQuery) {
	chatID, msgID, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	h.editHTMLWithKeyboard(ctx, chatID, msgID, menuText(), mainKeyboard())
}

func (h *Handler) showSystemState(ctx context.Context, cq *tg.CallbackQuery) {
	chatID, msgID, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}

	metricsCtx, cancel := context.WithTimeout(ctx, h.cfg.MetricsTimeout)
	defer cancel()
	m, err := system.GetMetrics(metricsCtx)
	if err != nil {
		h.editText(ctx, chatID, msgID, "Не удалось получить метрики системы")
		return
	}

	apiCtx, apiCancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer apiCancel()
	profiles, err := h.svc.ListProfiles(apiCtx)
	if err != nil {
		h.editText(ctx, chatID, msgID, "Не удалось загрузить пользователей")
		return
	}

	totalUsageGB := float64(service.ServerTotalUsageBytes(profiles)) / 1024 / 1024 / 1024
	text := fmt.Sprintf("🖥 <b>Состояние системы</b>\n\n• Ядер: <b>%d</b>\n• CPU: <b>%.1f%%</b>\n• RAM: <b>%d MB / %d MB</b>\n• Общее количество пользователей: <b>%d</b>\n• Общий трафик сервера: <b>%.2f GB</b>", m.Cores, m.CPUPercent, m.RAMUsedMB, m.RAMTotalMB, len(profiles), totalUsageGB)
	h.editHTMLWithKeyboard(ctx, chatID, msgID, text, mainKeyboard())
}

func (h *Handler) restartXray(ctx context.Context, cq *tg.CallbackQuery) {
	chatID, _, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}

	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	if err := h.svc.ReloadXray(apiCtx); err == nil {
		h.sendHTMLWithKeyboard(chatID, "✅ Изменения Xray применены", mainKeyboard())
		return
	}

	cmdCtx, restartCancel := context.WithTimeout(ctx, h.cfg.CommandTimeout)
	defer restartCancel()
	details, err := system.RestartXray(cmdCtx)
	if err == nil {
		h.sendHTMLWithKeyboard(chatID, "⚠️ Reload недоступен, выполнена перезагрузка Xray", mainKeyboard())
		return
	}

	text := "❌ Перезагрузка провалилась"
	if details != "" {
		text += "\n\n<code>" + html.EscapeString(sanitizeCode(details)) + "</code>"
	}
	h.sendHTMLWithKeyboard(chatID, text, mainKeyboard())
}

func (h *Handler) showUsersPage(ctx context.Context, cq *tg.CallbackQuery, page int) {
	chatID, msgID, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	profiles, err := h.svc.ListProfiles(apiCtx)
	if err != nil {
		h.editText(ctx, chatID, msgID, "Ошибка загрузки пользователей")
		return
	}
	items, current, total := service.PaginateProfiles(profiles, page, h.cfg.UsersPerPage)
	text := fmt.Sprintf("👥 <b>Пользователи</b>\nСтраница: <b>%d/%d</b>", current, total)
	h.editHTMLWithKeyboard(ctx, chatID, msgID, text, usersKeyboard(items, current, total))
}

func usersKeyboard(items []model.Profile, current, total int) *tg.InlineKeyboardMarkup {
	rows := make([][]tg.InlineKeyboardButton, 0, len(items)+3)
	for _, p := range items {
		rows = append(rows, []tg.InlineKeyboardButton{{Text: p.Username, CallbackData: "ud:" + strconv.Itoa(p.ID)}})
	}
	rows = append(rows, []tg.InlineKeyboardButton{{Text: "Добавить пользователя", CallbackData: "ad"}})
	if total > 1 {
		nav := make([]tg.InlineKeyboardButton, 0, 2)
		if current > 1 {
			nav = append(nav, tg.InlineKeyboardButton{Text: "Назад", CallbackData: "pg:" + strconv.Itoa(current-1)})
		}
		if current < total {
			nav = append(nav, tg.InlineKeyboardButton{Text: "Вперед", CallbackData: "pg:" + strconv.Itoa(current+1)})
		}
		if len(nav) > 0 {
			rows = append(rows, nav)
		}
	}
	rows = append(rows, []tg.InlineKeyboardButton{{Text: "В меню", CallbackData: "menu"}})
	return &tg.InlineKeyboardMarkup{InlineKeyboard: rows}
}

func (h *Handler) showUserDetails(ctx context.Context, cq *tg.CallbackQuery, id int) {
	chatID, msgID, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	profiles, err := h.svc.ListProfiles(apiCtx)
	if err != nil {
		h.editText(ctx, chatID, msgID, "Ошибка загрузки пользователя")
		return
	}
	page := findPageByID(profiles, id, h.cfg.UsersPerPage)
	text, err := h.svc.GetUserDetails(apiCtx, id)
	if err != nil {
		h.editText(ctx, chatID, msgID, "Ошибка загрузки пользователя")
		return
	}
	h.editHTMLWithKeyboard(ctx, chatID, msgID, text, userDetailsKeyboard(id, page))
}

func userDetailsKeyboard(id, page int) *tg.InlineKeyboardMarkup {
	pagePart := strconv.Itoa(page)
	return &tg.InlineKeyboardMarkup{InlineKeyboard: [][]tg.InlineKeyboardButton{
		{{Text: "Назад", CallbackData: "bk:" + strconv.Itoa(page)}},
		{{Text: "Включить / Выключить", CallbackData: "ut:" + strconv.Itoa(id)}},
		{{Text: "Удалить", CallbackData: "ux:" + strconv.Itoa(id) + ":" + pagePart}},
		{{Text: "Изменить", CallbackData: "ue:" + strconv.Itoa(id)}},
	}}
}

func findPageByID(items []model.Profile, id, pageSize int) int {
	if pageSize < 1 {
		pageSize = 8
	}
	for i, p := range items {
		if p.ID == id {
			return i/pageSize + 1
		}
	}
	return 1
}

func (h *Handler) toggleUser(ctx context.Context, cq *tg.CallbackQuery, id int) {
	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	if err := h.svc.ToggleUser(apiCtx, id); err != nil {
		h.answerCallback(ctx, cq.ID, "Ошибка переключения")
		return
	}
	h.showUserDetails(ctx, cq, id)
}

func (h *Handler) deleteUser(ctx context.Context, cq *tg.CallbackQuery, id int, page int) {
	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	if err := h.svc.DeleteUser(apiCtx, id); err != nil {
		h.answerCallback(ctx, cq.ID, "Ошибка удаления")
		return
	}
	if page < 1 {
		page = 1
	}
	h.showUsersPage(ctx, cq, page)
}

func (h *Handler) startEditUser(ctx context.Context, cq *tg.CallbackQuery, id int) {
	chatID, msgID, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	profiles, err := h.svc.ListProfiles(apiCtx)
	if err != nil {
		h.editText(ctx, chatID, msgID, "Ошибка загрузки")
		return
	}
	username := ""
	for _, p := range profiles {
		if p.ID == id {
			username = p.Username
			break
		}
	}
	session, inbounds, err := h.svc.StartEditInbounds(apiCtx, id, username)
	if err != nil {
		h.editText(ctx, chatID, msgID, "Ошибка загрузки")
		return
	}
	h.store.SetEdit(cq.From.ID, session)
	h.renderEditUser(ctx, chatID, msgID, session, inbounds)
}

func (h *Handler) toggleInboundInEdit(ctx context.Context, cq *tg.CallbackQuery, tag string) {
	chatID, msgID, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	session, ok := h.store.GetEdit(cq.From.ID)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сессия истекла")
		return
	}
	session = service.ToggleInbound(session, tag)
	h.store.SetEdit(cq.From.ID, session)

	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	inbounds, err := h.svc.GetInbounds(apiCtx)
	if err != nil {
		h.answerCallback(ctx, cq.ID, "Ошибка")
		return
	}
	h.renderEditUser(ctx, chatID, msgID, session, inbounds)
}

func (h *Handler) applyEditUser(ctx context.Context, cq *tg.CallbackQuery) {
	chatID, msgID, hasMessage := callbackMessageMeta(cq)
	session, ok := h.store.GetEdit(cq.From.ID)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сессия истекла")
		return
	}
	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	if err := h.svc.ApplyEditInbounds(apiCtx, session); err != nil {
		if hasMessage {
			h.editText(ctx, chatID, msgID, "Не удалось применить изменения")
		}
		return
	}
	h.store.DeleteEdit(cq.From.ID)
	h.showUserDetails(ctx, cq, session.UserID)
}

func (h *Handler) cancelEditUser(ctx context.Context, cq *tg.CallbackQuery) {
	chatID, msgID, hasMessage := callbackMessageMeta(cq)
	session, ok := h.store.GetEdit(cq.From.ID)
	h.store.DeleteEdit(cq.From.ID)
	if !ok {
		if hasMessage {
			h.editText(ctx, chatID, msgID, "Изменения отменены")
		}
		return
	}
	h.showUserDetails(ctx, cq, session.UserID)
}

func (h *Handler) renderEditUser(ctx context.Context, chatID int64, msgID int, session state.EditInboundsSession, inbounds []model.Inbound) {
	sort.Slice(inbounds, func(i, j int) bool { return inbounds[i].Tag < inbounds[j].Tag })
	rows := make([][]tg.InlineKeyboardButton, 0, len(inbounds)+1)
	for _, ib := range inbounds {
		prefix := "❌"
		if session.Working[ib.Tag] {
			prefix = "✅"
		}
		rows = append(rows, []tg.InlineKeyboardButton{{Text: prefix + " " + ib.Tag, CallbackData: "uig:" + ib.Tag}})
	}
	rows = append(rows, []tg.InlineKeyboardButton{{Text: "Готово", CallbackData: "uok"}, {Text: "Отмена", CallbackData: "ucn"}})
	h.editHTMLWithKeyboard(ctx, chatID, msgID, service.BuildEditTitle(session.Username), &tg.InlineKeyboardMarkup{InlineKeyboard: rows})
}

func (h *Handler) startAddConversation(ctx context.Context, cq *tg.CallbackQuery) {
	chatID, _, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	h.store.SetConversation(cq.From.ID, state.AddUserConversation{Step: state.AddStepUsername, StartedAt: time.Now(), UpdatedAt: time.Now()})
	_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{ChatID: chatID, Text: "Введите имя пользователя:", ReplyMarkup: cancelConversationKeyboard()})
}

func (h *Handler) applyAddInboundsChoice(ctx context.Context, cq *tg.CallbackQuery, value int) {
	chatID, _, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	conv, ok := h.store.GetConversation(cq.From.ID)
	if !ok || conv.Step != state.AddStepAddInbounds {
		h.answerCallback(ctx, cq.ID, "Сессия истекла")
		return
	}
	if value != 0 && value != 1 {
		h.answerCallback(ctx, cq.ID, "Некорректный выбор")
		return
	}
	conv.AddAll = value == 1
	apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
	defer cancel()
	created, err := h.svc.CreateUser(apiCtx, conv)
	h.store.DeleteConversation(cq.From.ID)
	if err != nil {
		h.send(chatID, "Ошибка создания пользователя: "+err.Error())
		h.sendMenu(chatID)
		return
	}
	h.sendHTML(chatID, fmt.Sprintf("✅ Пользователь создан: <b>%s</b> (ID %d)", html.EscapeString(created.Username), created.ID))
	h.sendMenu(chatID)
}

func (h *Handler) applyAddExpiryChoice(ctx context.Context, cq *tg.CallbackQuery, days int) {
	chatID, _, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	conv, ok := h.store.GetConversation(cq.From.ID)
	if !ok || conv.Step != state.AddStepExpireDays {
		h.answerCallback(ctx, cq.ID, "Сессия истекла")
		return
	}
	if days < 0 {
		h.answerCallback(ctx, cq.ID, "Некорректный срок")
		return
	}
	conv.ExpireDays = days
	conv.Step = state.AddStepAddInbounds
	h.store.SetConversation(cq.From.ID, conv)
	_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{
		ChatID: chatID,
		Text:   "Добавить все inbound сразу?",
		ReplyMarkup: &tg.InlineKeyboardMarkup{InlineKeyboard: [][]tg.InlineKeyboardButton{
			{{Text: "Да", CallbackData: "adib:1"}, {Text: "Нет", CallbackData: "adib:0"}},
			{{Text: "Отмена", CallbackData: "acn"}},
		}},
	})
}

func (h *Handler) cancelAddConversation(ctx context.Context, cq *tg.CallbackQuery) {
	chatID, _, ok := callbackMessageMeta(cq)
	if !ok {
		h.answerCallback(ctx, cq.ID, "Сообщение недоступно")
		return
	}
	h.store.DeleteConversation(cq.From.ID)
	h.send(chatID, "Добавление пользователя отменено")
	h.sendMenu(chatID)
}

func (h *Handler) handleConversationMessage(ctx context.Context, msg *tg.Message) {
	if msg == nil || msg.From == nil {
		return
	}
	if !h.authorized(msg.From.ID) {
		return
	}
	conv, ok := h.store.GetConversation(msg.From.ID)
	if !ok {
		return
	}
	text := strings.TrimSpace(msg.Text)

	switch conv.Step {
	case state.AddStepUsername:
		if len(text) < 3 {
			h.send(msg.Chat.ID, "Имя слишком короткое, минимум 3 символа")
			return
		}
		conv.Username = text
		conv.Step = state.AddStepLimitGB
		h.store.SetConversation(msg.From.ID, conv)
		_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{ChatID: msg.Chat.ID, Text: "Введите лимит трафика в GB (0 = безлимит):", ReplyMarkup: cancelConversationKeyboard()})
	case state.AddStepLimitGB:
		v, err := service.ParsePositiveFloat(text)
		if err != nil {
			h.send(msg.Chat.ID, "Некорректный лимит. Введите число >= 0")
			return
		}
		conv.LimitGB = v
		conv.Step = state.AddStepExpireDays
		h.store.SetConversation(msg.From.ID, conv)
		_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{
			ChatID: msg.Chat.ID,
			Text:   "Введите срок действия в днях (0 = никогда) или выберите вариант:",
			ReplyMarkup: &tg.InlineKeyboardMarkup{InlineKeyboard: [][]tg.InlineKeyboardButton{
				{{Text: "0 (Никогда)", CallbackData: "aex:0"}, {Text: "7 дней", CallbackData: "aex:7"}},
				{{Text: "30 дней", CallbackData: "aex:30"}, {Text: "90 дней", CallbackData: "aex:90"}},
				{{Text: "Отмена", CallbackData: "acn"}},
			}},
		})
	case state.AddStepExpireDays:
		v, err := service.ParseNonNegativeInt(text)
		if err != nil {
			h.send(msg.Chat.ID, "Некорректное число дней")
			return
		}
		conv.ExpireDays = v
		conv.Step = state.AddStepAddInbounds
		h.store.SetConversation(msg.From.ID, conv)
		_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{
			ChatID: msg.Chat.ID,
			Text:   "Добавить все inbound сразу?",
			ReplyMarkup: &tg.InlineKeyboardMarkup{InlineKeyboard: [][]tg.InlineKeyboardButton{
				{{Text: "Да", CallbackData: "adib:1"}, {Text: "Нет", CallbackData: "adib:0"}},
				{{Text: "Отмена", CallbackData: "acn"}},
			}},
		})
	case state.AddStepAddInbounds:
		s := strings.ToLower(text)
		if s == "да" || s == "yes" || s == "y" {
			conv.AddAll = true
		} else if s == "нет" || s == "no" || s == "n" {
			conv.AddAll = false
		} else {
			h.send(msg.Chat.ID, "Используйте кнопки ниже: Да / Нет")
			return
		}
		apiCtx, cancel := context.WithTimeout(ctx, h.cfg.RequestTimeout)
		defer cancel()
		created, err := h.svc.CreateUser(apiCtx, conv)
		h.store.DeleteConversation(msg.From.ID)
		if err != nil {
			h.send(msg.Chat.ID, "Ошибка создания пользователя: "+err.Error())
			h.sendMenu(msg.Chat.ID)
			return
		}
		h.sendHTML(msg.Chat.ID, fmt.Sprintf("✅ Пользователь создан: <b>%s</b> (ID %d)", html.EscapeString(created.Username), created.ID))
		h.sendMenu(msg.Chat.ID)
	}
}

func (h *Handler) send(chatID int64, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{ChatID: chatID, Text: text})
}

func (h *Handler) sendHTML(chatID int64, text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{ChatID: chatID, Text: text, ParseMode: tg.ParseModeHTML})
}

func (h *Handler) sendMenu(chatID int64) {
	h.sendHTMLWithKeyboard(chatID, menuText(), mainKeyboard())
}

func (h *Handler) sendHTMLWithKeyboard(chatID int64, text string, kb *tg.InlineKeyboardMarkup) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.bot.SendMessage(ctx, &botapi.SendMessageParams{ChatID: chatID, Text: text, ParseMode: tg.ParseModeHTML, ReplyMarkup: kb})
}

func (h *Handler) answerCallback(ctx context.Context, id, text string) {
	_, _ = h.bot.AnswerCallbackQuery(ctx, &botapi.AnswerCallbackQueryParams{CallbackQueryID: id, Text: text})
}

func (h *Handler) editText(ctx context.Context, chatID int64, messageID int, text string) {
	h.editTextWithKeyboard(ctx, chatID, messageID, text, nil)
}

func (h *Handler) editTextWithKeyboard(ctx context.Context, chatID int64, messageID int, text string, kb *tg.InlineKeyboardMarkup) {
	params := &botapi.EditMessageTextParams{ChatID: chatID, MessageID: messageID, Text: text, ReplyMarkup: kb}
	if _, err := h.bot.EditMessageText(ctx, params); err != nil {
		h.log.Warn("edit message failed", "error", err)
	}
}

func (h *Handler) editHTMLWithKeyboard(ctx context.Context, chatID int64, messageID int, text string, kb *tg.InlineKeyboardMarkup) {
	params := &botapi.EditMessageTextParams{ChatID: chatID, MessageID: messageID, Text: text, ParseMode: tg.ParseModeHTML, ReplyMarkup: kb}
	if _, err := h.bot.EditMessageText(ctx, params); err != nil {
		h.log.Warn("edit message failed", "error", err)
	}
}

func parseInt(parts []string, idx, def int) int {
	if len(parts) <= idx {
		return def
	}
	v, err := strconv.Atoi(parts[idx])
	if err != nil {
		return def
	}
	return v
}

func sanitizeCode(s string) string {
	return strings.ReplaceAll(s, "`", "'")
}

func callbackMessageMeta(cq *tg.CallbackQuery) (chatID int64, messageID int, ok bool) {
	if cq == nil {
		return 0, 0, false
	}
	if cq.Message.Message != nil {
		return cq.Message.Message.Chat.ID, cq.Message.Message.ID, true
	}
	if cq.Message.InaccessibleMessage != nil {
		return cq.Message.InaccessibleMessage.Chat.ID, cq.Message.InaccessibleMessage.MessageID, true
	}
	return 0, 0, false
}

func cancelConversationKeyboard() *tg.InlineKeyboardMarkup {
	return &tg.InlineKeyboardMarkup{InlineKeyboard: [][]tg.InlineKeyboardButton{{{Text: "Отмена", CallbackData: "acn"}}}}
}
