import {
    characters,
    this_chid,
    chat,
    getRequestHeaders,
    saveChatConditional,
    selectCharacterById,
    openCharacterChat,
    event_types,
    eventSource,
} from '../../../../script.js';
import { selected_group } from '../../../group-chats.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';
import { delay } from '../../../utils.js';

/**
 * Build the character selector popup HTML.
 * @returns {string} HTML string
 */
function buildCharacterSelectorHtml() {
    const sortedChars = characters
        .map((c, idx) => ({ ...c, idx }))
        .filter(c => c.idx !== this_chid)
        .sort((a, b) => a.name.localeCompare(b.name));

    let options = sortedChars.map(c =>
        `<option value="${c.idx}" data-avatar="${c.avatar}">${c.name}</option>`,
    ).join('');

    return `
        <div class="transfer-chat-popup">
            <h3>聊天记录换卡</h3>
            <p>选择要将当前聊天记录转移到的目标角色：</p>
            <div class="transfer-chat-search-row">
                <input type="text" id="transfer_chat_search" class="text_pole" placeholder="搜索角色..." />
            </div>
            <select id="transfer_chat_target" class="text_pole" size="12">
                ${options}
            </select>
            <label class="checkbox_label">
                <input type="checkbox" id="transfer_chat_switch" checked />
                <span>转移后自动切换到目标角色</span>
            </label>
        </div>
    `;
}

/**
 * Export the current chat as raw JSONL from the server,
 * then import it into the target character via multipart upload.
 * This avoids serializing the entire chat in the JSON request body,
 * which breaks for large (4MB+) chats.
 * @param {object} targetChar Target character object
 * @returns {Promise<string|null>} The imported chat file name (without .jsonl), or null on failure
 */
async function copyCurrentChatToCharacter(targetChar) {
    const sourceChar = characters[this_chid];
    const currentChatName = sourceChar.chat;

    const exportResponse = await fetch('/api/chats/export', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            avatar_url: sourceChar.avatar,
            file: `${currentChatName}.jsonl`,
            exportfilename: `${currentChatName}.jsonl`,
            format: 'jsonl',
            is_group: false,
        }),
    });

    if (!exportResponse.ok) {
        throw new Error(`导出聊天失败: ${exportResponse.status}`);
    }

    const exportData = await exportResponse.json();
    const rawJsonl = exportData.result;

    if (!rawJsonl || rawJsonl.length === 0) {
        throw new Error('导出的聊天内容为空');
    }

    const blob = new Blob([rawJsonl], { type: 'application/jsonl' });
    const file = new File([blob], `${currentChatName}.jsonl`, { type: 'application/jsonl' });

    const formData = new FormData();
    formData.set('avatar', file);
    formData.set('avatar_url', targetChar.avatar);
    formData.set('file_type', 'jsonl');
    formData.set('character_name', targetChar.name);
    formData.set('user_name', 'User');

    const importResponse = await fetch('/api/chats/import', {
        method: 'POST',
        body: formData,
        headers: getRequestHeaders({ omitContentType: true }),
        cache: 'no-cache',
    });

    if (!importResponse.ok) {
        throw new Error(`导入聊天失败: ${importResponse.status}`);
    }

    const importData = await importResponse.json();
    if (!importData.res || !importData.fileNames?.length) {
        throw new Error('导入返回异常');
    }

    return importData.fileNames[0].replace('.jsonl', '');
}

/**
 * Perform the chat transfer.
 */
async function transferChat() {
    if (selected_group) {
        toastr.warning('此功能不支持群组聊天。', '转移聊天');
        return;
    }

    if (this_chid === undefined || !characters[this_chid]) {
        toastr.warning('请先选择一个角色。', '转移聊天');
        return;
    }

    if (chat.length === 0) {
        toastr.warning('当前聊天记录为空。', '转移聊天');
        return;
    }

    const html = buildCharacterSelectorHtml();

    let selectedTargetIdx = NaN;
    let shouldSwitch = true;

    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
        okButton: '确认转移',
        cancelButton: '取消',
        wide: false,
        allowVerticalScrolling: true,
        onOpen: (popup) => {
            const search = popup.dlg.querySelector('#transfer_chat_search');
            const select = popup.dlg.querySelector('#transfer_chat_target');
            if (search && select) {
                search.addEventListener('input', () => {
                    const query = search.value.toLowerCase();
                    for (const opt of select.options) {
                        opt.hidden = !opt.textContent.toLowerCase().includes(query);
                    }
                });
                setTimeout(() => search.focus(), 100);
            }
        },
        onClose: (popup) => {
            const select = popup.dlg.querySelector('#transfer_chat_target');
            const checkbox = popup.dlg.querySelector('#transfer_chat_switch');
            selectedTargetIdx = parseInt(select?.value);
            shouldSwitch = checkbox?.checked ?? true;
        },
    });

    if (result !== 1) return;

    if (isNaN(selectedTargetIdx) || !characters[selectedTargetIdx]) {
        toastr.error('请先选择一个目标角色。', '转移聊天');
        return;
    }

    const targetChar = characters[selectedTargetIdx];

    try {
        toastr.info('正在转移聊天记录...', '转移聊天', { timeOut: 2000 });

        await saveChatConditional();

        const importedChatName = await copyCurrentChatToCharacter(targetChar);

        toastr.success(
            `聊天记录已成功转移到 ${targetChar.name}！`,
            '转移聊天',
        );

        if (shouldSwitch && importedChatName) {
            await selectCharacterById(selectedTargetIdx);
            await delay(500);
            await openCharacterChat(importedChatName);
        }
    } catch (error) {
        console.error('[Transfer Chat] Error:', error);
        toastr.error(`转移失败: ${error.message}`, '转移聊天');
    }
}

/**
 * Initialize the extension: add UI entry points.
 */
export async function init() {
    $('#char-management-dropdown').append(
        $('<option>', {
            id: 'transfer_chat_to_character',
            text: '转移聊天记录',
        }),
    );

    eventSource.on(event_types.CHARACTER_MANAGEMENT_DROPDOWN, (selectedOptionId) => {
        if (selectedOptionId === 'transfer_chat_to_character') {
            transferChat();
        }
    });

    const menuContainer = document.getElementById('extensionsMenu');
    if (menuContainer) {
        const btn = document.createElement('div');
        btn.id = 'transfer_chat_wand_button';
        btn.classList.add('list-group-item', 'flex-container', 'flexGap5');

        const icon = document.createElement('div');
        icon.classList.add('fa-solid', 'fa-right-left', 'extensionsMenuExtensionButton');

        const label = document.createElement('span');
        label.textContent = '转移聊天记录';

        btn.appendChild(icon);
        btn.appendChild(label);
        btn.addEventListener('click', () => transferChat());
        menuContainer.appendChild(btn);
    }
}
