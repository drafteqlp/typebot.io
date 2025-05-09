import type { Coordinates, CoordinatesMap } from "@/features/graph/types";
import { createId } from "@paralleldrive/cuid2";
import {
  blockHasItems,
  blockHasOptions,
} from "@typebot.io/blocks-core/helpers";
import type {
  BlockIndices,
  BlockV6,
  BlockWithItems,
} from "@typebot.io/blocks-core/schemas/schema";
import { LogicBlockType } from "@typebot.io/blocks-logic/constants";
import type { GroupV6 } from "@typebot.io/groups/schemas";
import { parseUniqueKey } from "@typebot.io/lib/parseUniqueKey";
import { byId, isEmpty } from "@typebot.io/lib/utils";
import type { Edge } from "@typebot.io/typebot/schemas/edge";
import type { TypebotV6 } from "@typebot.io/typebot/schemas/typebot";
import { extractVariableIdsFromObject } from "@typebot.io/variables/extractVariablesFromObject";
import type { Variable } from "@typebot.io/variables/schemas";
import { type Draft, produce } from "immer";
import type { SetTypebot } from "../TypebotProvider";
import { createBlockDraft, deleteGroupDraft } from "./blocks";

export type GroupsActions = {
  createGroup: (
    props: Coordinates & {
      id: string;
      block: BlockV6 | BlockV6["type"];
      indices: BlockIndices;
    },
  ) => string | void;
  updateGroup: (
    groupIndex: number,
    updates: Partial<Omit<GroupV6, "id">>,
  ) => void;
  pasteGroups: (
    groups: GroupV6[],
    edges: Edge[],
    variables: Pick<Variable, "id" | "name">[],
    oldToNewIdsMapping: Map<string, string>,
  ) => void;
  updateGroupsCoordinates: (newCoord: CoordinatesMap) => void;
  deleteGroup: (groupIndex: number) => void;
  deleteGroups: (groupIds: string[]) => void;
};

const groupsActions = (setTypebot: SetTypebot): GroupsActions => ({
  createGroup: ({
    id,
    block,
    indices,
    groupLabel,
    ...graphCoordinates
  }: Coordinates & {
    id: string;
    groupLabel?: string;
    block: BlockV6 | BlockV6["type"];
    indices: BlockIndices;
  }) => {
    let newBlockId;
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        const newGroup: GroupV6 = {
          id,
          graphCoordinates,
          title: `${groupLabel ?? "Group"} #${typebot.groups.length + 1}`,
          blocks: [],
        };
        typebot.groups.push(newGroup);
        newBlockId = createBlockDraft(typebot, block, indices);
      }),
    );
    return newBlockId;
  },
  updateGroup: (groupIndex: number, updates: Partial<Omit<GroupV6, "id">>) =>
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        const block = typebot.groups[groupIndex];
        typebot.groups[groupIndex] = { ...block, ...updates };
      }),
    ),
  updateGroupsCoordinates: (newCoord: CoordinatesMap) => {
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        typebot.groups.forEach((group) => {
          if (newCoord[group.id]) {
            group.graphCoordinates = newCoord[group.id];
          }
        });
      }),
    );
  },
  deleteGroup: (groupIndex: number) =>
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        deleteGroupDraft(typebot)(groupIndex);
      }),
    ),
  deleteGroups: (groupIds: string[]) =>
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        groupIds.forEach((groupId) => {
          deleteGroupByIdDraft(typebot)(groupId);
        });
      }),
    ),
  pasteGroups: (
    groups: GroupV6[],
    edges: Edge[],
    variables: Omit<Variable, "value">[],
    oldToNewIdsMapping: Map<string, string>,
  ) => {
    setTypebot((typebot) =>
      produce(typebot, (typebot) => {
        const edgesToCreate: Edge[] = [];
        const variablesToCreate: Omit<Variable, "value">[] = [];
        variables.forEach((variable) => {
          const existingVariable = typebot.variables.find(
            (v) => v.name === variable.name,
          );
          if (existingVariable) {
            oldToNewIdsMapping.set(variable.id, existingVariable.id);
            return;
          }
          const id = createId();
          oldToNewIdsMapping.set(variable.id, id);
          variablesToCreate.push({
            ...variable,
            id,
          });
        });
        const newGroups: GroupV6[] = [];
        groups.forEach((group) => {
          const groupTitle = isEmpty(group.title)
            ? ""
            : parseUniqueKey(
                group.title,
                typebot.groups.map((g) => g.title),
              );
          const newGroup: GroupV6 = {
            ...group,
            title: groupTitle,
            blocks: group.blocks.map((block) => {
              let newBlock = { ...block };
              const blockId = createId();
              oldToNewIdsMapping.set(newBlock.id, blockId);
              const variableIdsToReplace = extractVariableIdsFromObject(
                newBlock,
              ).filter((v) => oldToNewIdsMapping.has(v));
              if (variableIdsToReplace.length > 0) {
                let blockStr = JSON.stringify(newBlock);
                variableIdsToReplace.forEach((variableId) => {
                  const newId = oldToNewIdsMapping.get(variableId);
                  if (!newId) return;
                  blockStr = blockStr.replace(variableId, newId);
                });
                newBlock = JSON.parse(blockStr);
              }
              if (blockHasItems(newBlock)) {
                newBlock.items = newBlock.items?.map((item) => {
                  const id = createId();
                  let outgoingEdgeId = item.outgoingEdgeId;
                  if (outgoingEdgeId) {
                    const edge = edges.find(byId(outgoingEdgeId));
                    if (edge) {
                      outgoingEdgeId = createId();
                      edgesToCreate.push({
                        ...edge,
                        id: outgoingEdgeId,
                      });
                      oldToNewIdsMapping.set(item.id, id);
                    } else {
                      outgoingEdgeId = undefined;
                    }
                  }
                  return {
                    ...item,
                    blockId,
                    id,
                    outgoingEdgeId,
                  };
                }) as BlockWithItems["items"];
              }
              let outgoingEdgeId = newBlock.outgoingEdgeId;
              if (outgoingEdgeId) {
                const edge = edges.find(byId(outgoingEdgeId));
                if (edge) {
                  outgoingEdgeId = createId();
                  edgesToCreate.push({
                    ...edge,
                    id: outgoingEdgeId,
                  });
                } else {
                  outgoingEdgeId = undefined;
                }
              }
              return {
                ...newBlock,
                id: blockId,
                outgoingEdgeId,
              };
            }),
          };
          newGroups.push(newGroup);
        });

        typebot.groups.push(
          ...newGroups.map((group) => {
            return {
              ...group,
              blocks: group.blocks.map((block) => {
                if (
                  block.type === LogicBlockType.JUMP &&
                  block.options?.groupId
                )
                  return {
                    ...block,
                    options: {
                      ...block.options,
                      groupId: oldToNewIdsMapping.get(block.options?.groupId),
                      blockId: block.options?.blockId
                        ? oldToNewIdsMapping.get(block.options?.blockId)
                        : undefined,
                    },
                  };
                return block;
              }),
            };
          }),
        );

        edgesToCreate.forEach((edge) => {
          if (!("blockId" in edge.from)) return;
          const fromBlockId = oldToNewIdsMapping.get(edge.from.blockId);
          const toGroupId = oldToNewIdsMapping.get(edge.to.groupId);
          if (!fromBlockId || !toGroupId) return;
          const newEdge: Edge = {
            ...edge,
            from: {
              ...edge.from,
              blockId: fromBlockId,
              itemId: edge.from.itemId
                ? oldToNewIdsMapping.get(edge.from.itemId)
                : undefined,
            },
            to: {
              ...edge.to,
              groupId: toGroupId,
              blockId: edge.to.blockId
                ? oldToNewIdsMapping.get(edge.to.blockId)
                : undefined,
            },
          };
          typebot.edges.push(newEdge);
        });

        variablesToCreate.forEach((variableToCreate) => {
          typebot.variables.unshift(variableToCreate);
        });
      }),
    );
  },
});

const deleteGroupByIdDraft =
  (typebot: Draft<TypebotV6>) => (groupId: string) => {
    const groupIndex = typebot.groups.findIndex(byId(groupId));
    if (groupIndex === -1) return;
    deleteGroupDraft(typebot)(groupIndex);
  };

export { groupsActions };
