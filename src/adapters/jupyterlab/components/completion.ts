import { DataConnector } from '@jupyterlab/coreutils';
import {
  CompletionConnector,
  CompletionHandler,
  ContextConnector,
  KernelConnector
} from '@jupyterlab/completer';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { ReadonlyJSONObject } from '@phosphor/coreutils';
import { completionItemKindNames, CompletionTriggerKind } from '../../../lsp';
import * as lsProtocol from 'vscode-languageserver-protocol';
import { PositionConverter } from '../../../converter';
import { IClientSession } from '@jupyterlab/apputils';
import { VirtualDocument } from '../../../virtual/document';
import { VirtualEditor } from '../../../virtual/editor';
import { CodeMirrorEditor } from '@jupyterlab/codemirror';
import { IEditorPosition } from '../../../positioning';
import { LSPConnection } from '../../../connection';
import { Completion, ILSPRequest } from '../../codemirror/features/completion';

/*
Feedback: anchor - not clear from docs
bundle - very not clear from the docs, interface or better docs would be nice to have
 */

/**
 * A LSP connector for completion handlers.
 */
export class LSPConnector extends DataConnector<
  CompletionHandler.IReply,
  void,
  CompletionHandler.IRequest
> {
  private readonly _editor: CodeEditor.IEditor;
  private readonly _connections: Map<VirtualDocument.id_path, LSPConnection>;
  private _context_connector: ContextConnector;
  private _kernel_connector: KernelConnector;
  private _kernel_and_context_connector: CompletionConnector;
  protected options: LSPConnector.IOptions;

  virtual_editor: VirtualEditor;
  private trigger_kind: CompletionTriggerKind;
  // TODO expose this in user settings
  private suppress_auto_invoke_in = ['comment', 'string'];

  /**
   * Create a new LSP connector for completion requests.
   *
   * @param options - The instantiation options for the LSP connector.
   */
  constructor(options: LSPConnector.IOptions) {
    super();
    this._editor = options.editor;
    this._connections = options.connections;
    this.virtual_editor = options.virtual_editor;
    this._context_connector = new ContextConnector({ editor: options.editor });
    if (options.session) {
      let kernel_options = { editor: options.editor, session: options.session };
      this._kernel_connector = new KernelConnector(kernel_options);
      this._kernel_and_context_connector = new CompletionConnector(
        kernel_options
      );
    }
    this.options = options;
  }

  protected get _kernel_language(): string {
    return this.options.session.kernel.info.language_info.name;
  }

  get fallback_connector() {
    return this._kernel_and_context_connector
      ? this._kernel_and_context_connector
      : this._context_connector;
  }

  /**
   * Fetch completion requests.
   *
   * @param request - The completion request text and details.
   */
  fetch(
    request: CompletionHandler.IRequest
  ): Promise<CompletionHandler.IReply> {
    let editor = this._editor;

    const cursor = editor.getCursorPosition();
    const token = editor.getTokenForPosition(cursor);

    console.log(token);

    if (this.suppress_auto_invoke_in.indexOf(token.type) !== -1) {
      console.log('Suppressing completer auto-invoke in', token.type);
      return;
    }

    const start = editor.getPositionAt(token.offset);
    const end = editor.getPositionAt(token.offset + token.value.length);

    let cm_editor = (this._editor as CodeMirrorEditor).editor;

    const to_cm_editor_position = (position: CodeEditor.IPosition) =>
      PositionConverter.ce_to_cm(position) as IEditorPosition;

    let lsp_request = Completion.generateRequestAt(
      token.value,
      to_cm_editor_position(start),
      to_cm_editor_position(end),
      to_cm_editor_position(cursor),
      token.offset,
      this.virtual_editor,
      cm_editor
    );

    try {
      if (
        this._kernel_connector &&
        // TODO: this would be awesome if we could connect to rpy2 for R suggestions in Python,
        //  but this is not the job of this extension; nevertheless its better to keep this in
        //  mind to avoid introducing design decisions which would make this impossible
        //  (for other extensions)
        lsp_request.document.language === this._kernel_language
      ) {
        return Promise.all([
          this._kernel_connector.fetch(request),
          this.hint(lsp_request)
        ]).then(([kernel, lsp]) =>
          this.merge_replies(kernel, lsp, this._editor)
        );
      }

      return this.hint(lsp_request).catch(e => {
        console.log(e);
        return this.fallback_connector.fetch(request);
      });
    } catch (e) {
      return this.fallback_connector.fetch(request);
    }
  }

  async hint(request: ILSPRequest): Promise<CompletionHandler.IReply> {
    let { document, offset } = request;
    let value = request.virtual_token.text;
    let connection = this._connections.get(document.id_path);

    // nope - do not do this; we need to get the signature (yes)
    // but only in order to bump the priority of the parameters!
    // unfortunately there is no abstraction of scores exposed
    // to the matches...
    // Suggested in https://github.com/jupyterlab/jupyterlab/issues/7044, TODO PR

    let completion_items: lsProtocol.CompletionItem[] = [];
    await connection
      .getCompletion(
        request.cursor,
        request.virtual_token,
        request.typed_character,
        this.trigger_kind
      )
      .then(items => {
        completion_items = items || [];
      });

    let matches: Array<string> = [];
    const types: Array<IItemType> = [];
    let all_non_prefixed = true;
    for (let match of completion_items) {
      // there are more interesting things to be extracted and passed to the metadata:
      // detail: "__main__"
      // documentation: "mean(data)↵↵Return the sample arithmetic mean of data.↵↵>>> mean([1, 2, 3, 4, 4])↵2.8↵↵>>> from fractions import Fraction as F↵>>> mean([F(3, 7), F(1, 21), F(5, 3), F(1, 3)])↵Fraction(13, 21)↵↵>>> from decimal import Decimal as D↵>>> mean([D("0.5"), D("0.75"), D("0.625"), D("0.375")])↵Decimal('0.5625')↵↵If ``data`` is empty, StatisticsError will be raised."
      // insertText: "mean"
      // kind: 3
      // label: "mean(data)"
      // sortText: "amean"
      let text = match.insertText ? match.insertText : match.label;

      if (text.startsWith(value)) {
        all_non_prefixed = false;
      }

      matches.push(text);
      types.push({
        text: text,
        type: match.kind ? completionItemKindNames[match.kind] : ''
      });
    }

    return {
      // note in the ContextCompleter it was:
      // start: token.offset,
      // end: token.offset + token.value.length,
      // which does not work with "from statistics import <tab>" as the last token ends at "t" of "import",
      // so the completer would append "mean" as "from statistics importmean" (without space!);
      // (in such a case the typedCharacters is undefined as we are out of range)
      // a different workaround would be to prepend the token.value prefix:
      // text = token.value + text;
      // but it did not work for "from statistics <tab>" and lead to "from statisticsimport" (no space)
      start: offset + (all_non_prefixed ? 1 : 0),
      end: offset + value.length,
      matches: matches,
      metadata: {
        _jupyter_types_experimental: types
      }
    };
  }

  private merge_replies(
    kernel: CompletionHandler.IReply,
    lsp: CompletionHandler.IReply,
    editor: CodeEditor.IEditor
  ) {
    // This is based on https://github.com/jupyterlab/jupyterlab/blob/f1bc02ced61881df94c49929837c49c022f5b115/packages/completer/src/connector.ts#L78
    // Copyright (c) Jupyter Development Team.
    // Distributed under the terms of the Modified BSD License.

    // If one is empty, return the other.
    if (kernel.matches.length === 0) {
      return lsp;
    } else if (lsp.matches.length === 0) {
      return kernel;
    }
    console.log('merging LSP and kernel completions:', lsp, kernel);

    // Populate the result with a copy of the lsp matches.
    const matches = lsp.matches.slice();
    const types = lsp.metadata._jupyter_types_experimental as Array<IItemType>;

    // Cache all the lsp matches in a memo.
    const memo = new Set<string>(matches);
    const memo_types = new Map<string, string>(
      types.map(v => [v.text, v.type])
    );

    let prefix = '';

    // if the kernel used a wider range, get the previous characters to strip the prefix off,
    // so that both use the same range
    if (lsp.start > kernel.start) {
      const cursor = editor.getCursorPosition();
      const line = editor.getLine(cursor.line);
      prefix = line.substring(kernel.start, kernel.end);
      console.log('will remove prefix from kernel response:', prefix);
    }

    let remove_prefix = (value: string) => {
      if (value.startsWith(prefix)) {
        return value.substr(prefix.length);
      }
      return value;
    };

    // TODO push the CompletionItem suggestion with proper sorting, this is a mess
    let priority_matches = new Set<string>();

    if (typeof kernel.metadata._jupyter_types_experimental !== 'undefined') {
      let kernel_types = kernel.metadata._jupyter_types_experimental as Array<
        IItemType
      >;
      kernel_types.forEach(itemType => {
        let text = remove_prefix(itemType.text);
        if (!memo_types.has(text)) {
          memo_types.set(text, itemType.type);
          if (itemType.type !== '<unknown>') {
            priority_matches.add(text);
          }
        }
      });
    }

    // Add each context match that is not in the memo to the result.
    kernel.matches.forEach(match => {
      match = remove_prefix(match);
      if (!memo.has(match) && !priority_matches.has(match)) {
        matches.push(match);
      }
    });

    let final_matches: Array<string> = Array.from(priority_matches).concat(
      matches
    );
    let merged_types: Array<IItemType> = Array.from(memo_types.entries()).map(
      ([key, value]) => ({ text: key, type: value })
    );

    return {
      ...lsp,
      matches: final_matches,
      metadata: {
        _jupyter_types_experimental: merged_types
      }
    };
  }

  with_trigger_kind(kind: CompletionTriggerKind, fn: Function) {
    try {
      this.trigger_kind = kind;
      return fn();
    } finally {
      // Return to the default state
      this.trigger_kind = CompletionTriggerKind.Invoked;
    }
  }
}

/**
 * A namespace for LSP connector statics.
 */
export namespace LSPConnector {
  /**
   * The instantiation options for cell completion handlers.
   */
  export interface IOptions {
    /**
     * The editor used by the LSP connector.
     */
    editor: CodeEditor.IEditor;
    virtual_editor: VirtualEditor;
    /**
     * The connections to be used by the LSP connector.
     */
    connections: Map<VirtualDocument.id_path, LSPConnection>;

    session?: IClientSession;
  }
}

interface IItemType extends ReadonlyJSONObject {
  // the item value
  text: string;
  // the item type
  type: string;
}
