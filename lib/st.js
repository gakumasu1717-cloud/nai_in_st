/**
 * NaiStudio - SillyTavern 내부 모듈 재수출 shim.
 *
 * ST 코어 경로는 확장 폴더 깊이에 따라 달라지므로, 경로 의존을 이 파일 한 곳에만 둔다.
 * (이 파일 기준: public/scripts/extensions/third-party/NaiStudio/lib/)
 */

export { extension_settings, getContext } from '../../../../extensions.js';
export {
    saveSettingsDebounced,
    eventSource,
    event_types,
    getRequestHeaders,
    characters,
    updateMessageBlock,
    appendMediaToMessage,
} from '../../../../../script.js';
export { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
export { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';

import * as stUtils from '../../../../utils.js';
export { stUtils };
