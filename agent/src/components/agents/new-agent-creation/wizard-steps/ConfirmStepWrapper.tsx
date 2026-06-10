import chalk from 'chalk';
import React, { type ReactNode, useCallback, useState } from 'react';
import { useSetAppState } from '../../../../state/AppState.js';
import type { Tools } from '../../../../Tool.js';
import type { AgentDefinition } from '../../../../tools/AgentTool/loadAgentsDir.js';
import { getActiveAgentsFromList } from '../../../../tools/AgentTool/loadAgentsDir.js';
import { editFileInEditor } from '../../../../utils/promptEditor.js';
import { useWizard } from '../../../wizard/index.js';
import { getNewAgentFilePath, saveAgentToFile } from '../../agentFileUtils.js';
import type { AgentWizardData } from '../types.js';
import { ConfirmStep } from './ConfirmStep.js';
type Props = {
  tools: Tools;
  existingAgents: AgentDefinition[];
  onComplete: (message: string) => void;
};
export function ConfirmStepWrapper({
  tools,
  existingAgents,
  onComplete
}: Props): ReactNode {
  const {
    wizardData
  } = useWizard<AgentWizardData>();
  const [saveError, setSaveError] = useState<string | null>(null);
  const setAppState = useSetAppState();
  const saveAgent = useCallback(async (openInEditor: boolean): Promise<void> => {
    if (!wizardData?.finalAgent) return;
    try {
      await saveAgentToFile(wizardData.location!, wizardData.finalAgent.agentType, wizardData.finalAgent.whenToUse, wizardData.finalAgent.tools, wizardData.finalAgent.getSystemPrompt(), true, wizardData.finalAgent.color, wizardData.finalAgent.model, wizardData.finalAgent.memory);
      setAppState(state => {
        if (!wizardData.finalAgent) return state;
        const allAgents = state.agentDefinitions.allAgents.concat(wizardData.finalAgent);
        return {
          ...state,
          agentDefinitions: {
            ...state.agentDefinitions,
            activeAgents: getActiveAgentsFromList(allAgents),
            allAgents
          }
        };
      });
      if (openInEditor) {
        const filePath = getNewAgentFilePath({
          source: wizardData.location!,
          agentType: wizardData.finalAgent.agentType
        });
        // The agent is already saved; the editor is an optional extra. If it
        // can't launch, don't claim it opened — point the user at the file.
        const editResult = await editFileInEditor(filePath);
        const baseMsg = `Created agent: ${chalk.bold(wizardData.finalAgent.agentType)}`;
        const message = editResult.content !== null
          ? `${baseMsg} and opened in editor. If you made edits, restart to load the latest version.`
          : `${baseMsg}. Edit it at ${filePath}` +
            (editResult.error ? ` (${editResult.error})` : '');
        onComplete(message);
        return;
      }
      onComplete(`Created agent: ${chalk.bold(wizardData.finalAgent.agentType)}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save agent');
    }
  }, [wizardData, onComplete, setAppState]);
  const handleSave = useCallback(() => saveAgent(false), [saveAgent]);
  const handleSaveAndEdit = useCallback(() => saveAgent(true), [saveAgent]);
  return <ConfirmStep tools={tools} existingAgents={existingAgents} onSave={handleSave} onSaveAndEdit={handleSaveAndEdit} error={saveError} />;
}
