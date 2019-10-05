import { CompletionTriggerKind } from '../../../lsp';
import { CodeMirrorLSPFeature } from '../feature';
import { IEditorPosition, IVirtualPosition } from '../../../positioning';
import { VirtualDocument } from '../../../virtual/document';
import CodeMirror = require('codemirror');
import { ITokenInfo } from 'lsp-editor-adapter';
import { VirtualEditor } from '../../../virtual/editor';

export interface ILSPRequest {
  virtual_token: ITokenInfo;
  offset: number;
  typed_character: string;
  start: IVirtualPosition;
  end: IVirtualPosition;
  cursor: IVirtualPosition;
  document: VirtualDocument;
}

export class Completion extends CodeMirrorLSPFeature {
  private _completionCharacters: string[];

  static generateRequestAt(
    value: string,
    start: IEditorPosition,
    end: IEditorPosition,
    cursor: IEditorPosition,
    offset: number,
    virtual_editor: VirtualEditor,
    cm_editor: CodeMirror.Editor
  ): ILSPRequest {
    const typed_character = value[cursor.ch - start.ch - 1];

    let transform_to_root = (position: IEditorPosition) =>
      virtual_editor.transform_editor_to_root(cm_editor, position);

    let start_in_root = transform_to_root(start);
    let end_in_root = transform_to_root(end);
    let cursor_in_root = transform_to_root(cursor);

    // find document for position
    let document = virtual_editor.document_at_root_position(start_in_root);

    let to_virtual = virtual_editor.root_position_to_virtual_position;

    let virtual_start = to_virtual(start_in_root);
    let virtual_end = to_virtual(end_in_root);
    let virtual_cursor = to_virtual(cursor_in_root);

    return {
      virtual_token: {
        start: virtual_start,
        end: virtual_end,
        text: value
      },
      offset,
      typed_character,
      start: virtual_start,
      end: virtual_end,
      cursor: virtual_cursor,
      document
    };
  }

  get completionCharacters() {
    if (
      typeof this._completionCharacters === 'undefined' ||
      !this._completionCharacters.length
    ) {
      this._completionCharacters = this.connection.getLanguageCompletionCharacters();
    }
    return this._completionCharacters;
  }

  // public handleCompletion(completions: lsProtocol.CompletionItem[]) {
  // TODO: populate the (already displayed) completions list if the completions timed out initially?
  // }

  afterChange(change: CodeMirror.EditorChange): void {
    // TODO: maybe the completer could be kicked off in the handleChange() method directly; signature help still
    //  requires an up-to-date virtual document on the LSP side, so we need to wait for sync.
    let last_character = this.extract_last_character(change);
    if (this.completionCharacters.indexOf(last_character) > -1) {
      this.jupyterlab_components.invoke_completer(
        CompletionTriggerKind.TriggerCharacter
      );
    }
  }
}
