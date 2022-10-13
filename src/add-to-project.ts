import * as core from '@actions/core'
import * as github from '@actions/github'

// TODO: Ensure this (and the Octokit client) works for non-github.com URLs, as well.
// https://github.com/orgs|users/<ownerName>/projects/<projectNumber>
const urlParse =
  /^(?:https:\/\/)?github\.com\/(?<ownerType>orgs|users)\/(?<ownerName>[^/]+)\/projects\/(?<projectNumber>\d+)/

interface ProjectNodeIDResponse {
  organization?: {
    projectV2: {
      id: string
    }
  }

  user?: {
    projectV2: {
      id: string
    }
  }
}

interface ProjectV2UpdateItemFieldValueResponse {
  updateProjectV2ItemFieldValue: {
    projectV2Item: {
      id: string
    }
  }
}

interface ProjectAddItemResponse {
  addProjectV2ItemById: {
    item: {
      id: string
    }
  }
}

interface ProjectV2AddDraftIssueResponse {
  addProjectV2DraftIssue: {
    projectItem: {
      id: string
    }
  }
}

interface ProjectV2GetFieldAndOptionResponse {
  node: {
    field: {
      id: string
      options: [
        {
          id: string
          name: string
        }
      ]
    }
  }
}

interface ProjectV2GetIterationResponse {
  node: {
    field: {
      id: string
      configuration: {
        iterations: [
          {
            startDate: string
            id: string
          }
        ]
      }
    }
  }
}

export async function addToProject(): Promise<void> {
  const projectUrl = core.getInput('project-url', {required: true})
  const ghToken = core.getInput('github-token', {required: true})
  const fieldName = core.getInput('field-name', {required: true})
  const fieldOptionName = core.getInput('field-option', {required: true})

  const labeled =
    core
      .getInput('labeled')
      .split(',')
      .map(l => l.trim().toLowerCase())
      .filter(l => l.length > 0) ?? []
  const labelOperator = core.getInput('label-operator').trim().toLocaleLowerCase()

  const octokit = github.getOctokit(ghToken)

  const issue = github.context.payload.issue ?? github.context.payload.pull_request
  const issueLabels: string[] = (issue?.labels ?? []).map((l: {name: string}) => l.name.toLowerCase())
  const issueOwnerName = github.context.payload.repository?.owner.login

  core.debug(`Issue/PR owner: ${issueOwnerName}`)

  // Ensure the issue matches our `labeled` filter based on the label-operator.
  if (labelOperator === 'and') {
    if (!labeled.every(l => issueLabels.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it doesn't match all the labels: ${labeled.join(', ')}`)
      return
    }
  } else if (labelOperator === 'not') {
    if (labeled.length > 0 && issueLabels.some(l => labeled.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it contains one of the labels: ${labeled.join(', ')}`)
      return
    }
  } else {
    if (labeled.length > 0 && !issueLabels.some(l => labeled.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it does not have one of the labels: ${labeled.join(', ')}`)
      return
    }
  }

  core.debug(`Project URL: ${projectUrl}`)

  const urlMatch = projectUrl.match(urlParse)

  if (!urlMatch) {
    throw new Error(
      `Invalid project URL: ${projectUrl}. Project URL should match the format https://github.com/<orgs-or-users>/<ownerName>/projects/<projectNumber>`
    )
  }

  const projectOwnerName = urlMatch.groups?.ownerName
  const projectNumber = parseInt(urlMatch.groups?.projectNumber ?? '', 10)
  const ownerType = urlMatch.groups?.ownerType
  const ownerTypeQuery = mustGetOwnerTypeQuery(ownerType)

  core.debug(`Project owner: ${projectOwnerName}`)
  core.debug(`Project number: ${projectNumber}`)
  core.debug(`Project owner type: ${ownerType}`)

  // First, use the GraphQL API to request the project's node ID.
  const idResp = await octokit.graphql<ProjectNodeIDResponse>(
    `query getProject($projectOwnerName: String!, $projectNumber: Int!) {
      ${ownerTypeQuery}(login: $projectOwnerName) {
        projectV2(number: $projectNumber) {
          id
        }
      }
    }`,
    {
      projectOwnerName,
      projectNumber
    }
  )

  const projectId = idResp[ownerTypeQuery]?.projectV2.id
  const contentId = issue?.node_id

  core.debug(`Project node ID: ${projectId}`)
  core.debug(`Content ID: ${contentId}`)

  // Next, use the GraphQL API to add the issue to the project.
  // If the issue has the same owner as the project, we can directly
  // add a project item. Otherwise, we add a draft issue.
  let createdItem = ''
  if (issueOwnerName === projectOwnerName) {
    core.info('Creating project item')

    const addResp = await octokit.graphql<ProjectAddItemResponse>(
      `mutation addIssueToProject($input: AddProjectV2ItemByIdInput!) {
        addProjectV2ItemById(input: $input) {
          item {
            id
          }
        }
      }`,
      {
        input: {
          projectId,
          contentId
        }
      }
    )
    const itemId = addResp.addProjectV2ItemById.item.id
    core.setOutput('itemId', addResp.addProjectV2ItemById.item.id)
    createdItem = itemId
  } else {
    core.info('Creating draft issue in project')

    const addResp = await octokit.graphql<ProjectV2AddDraftIssueResponse>(
      `mutation addDraftIssueToProject($projectId: ID!, $title: String!) {
        addProjectV2DraftIssue(input: {
          projectId: $projectId,
          title: $title
        }) {
          projectItem {
            id
          }
        }
      }`,
      {
        projectId,
        title: issue?.html_url
      }
    )

    const itemId = addResp.addProjectV2DraftIssue.projectItem.id
    core.setOutput('itemId', addResp.addProjectV2DraftIssue.projectItem.id)
    createdItem = itemId
  }
  core.debug(`Created Item ID: ${createdItem}`)

  // Find the field and option
  const queryFieldResp = await octokit.graphql<ProjectV2GetFieldAndOptionResponse>(
    `query getOptionField($projectId: ID!, $fieldName: String!) {
      node(id: $projectId) { ... on ProjectV2 {
        field(name: $fieldName) { ... on ProjectV2SingleSelectField {
          id
          options {
            id
            name
          }
        }}
      }}
    }`,
    {
      projectId,
      fieldName
    }
  )
  const fieldId = queryFieldResp.node.field.id
  core.debug(`Field Option ID: ${fieldId}`)
  const fieldOption = queryFieldResp.node.field.options.find(option => option.name === fieldOptionName)?.id
  core.debug(`Field Option option ID: ${fieldOption}`)

  // Next, now we have the item we can mutate it to place it in the desired iteration and column of our board
  const columnMoveResp = await octokit.graphql<ProjectV2UpdateItemFieldValueResponse>(
    `mutation addIssueToColumn($projectId: ID!, $itemId: ID!, $fieldId: ID!, $fieldOption: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { 
          singleSelectOptionId: $fieldOption       
        }
      }) {
        projectV2Item {
          id
        }
      }
    }`,
    {
      projectId,
      itemId: createdItem,
      fieldId,
      fieldOption
    }
  )
  core.setOutput('itemId', columnMoveResp.updateProjectV2ItemFieldValue.projectV2Item.id)

  // Find the latest iteration
  const queryIterationResp = await octokit.graphql<ProjectV2GetIterationResponse>(
    `query getIteration($projectId: ID!) {
      node(id: $projectId) { ... on ProjectV2 {
        field(name: "Iteration") { ... on ProjectV2IterationField {
          id
          configuration {
            iterations {
              startDate
              id
            }
          }
        }}
      }}
    }`,
    {
      projectId
    }
  )
  const iterationFieldId = queryIterationResp.node.field.id
  // Rationale is that we don't expect overlapping iterations
  const iterationId = queryIterationResp.node.field.configuration.iterations.reduce((previous, current) => {
    return previous.startDate > current.startDate ? previous : current
  }).id
  core.debug(`Iteration Field ID: ${iterationFieldId}`)
  core.debug(`Iteration ID: ${iterationId}`)

  // Next, now we have the item we can mutate it to place it in the desired iteration and column of our board
  const iterationMoveResp = await octokit.graphql<ProjectV2UpdateItemFieldValueResponse>(
    `mutation addIssueToIteration($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { 
          iterationId: $iterationId       
        }
      }) {
        projectV2Item {
          id
        }
      }
    }`,
    {
      projectId,
      itemId: createdItem,
      fieldId: iterationFieldId,
      iterationId
    }
  )
  core.setOutput('itemId', iterationMoveResp.updateProjectV2ItemFieldValue.projectV2Item.id)
}

export function mustGetOwnerTypeQuery(ownerType?: string): 'organization' | 'user' {
  const ownerTypeQuery = ownerType === 'orgs' ? 'organization' : ownerType === 'users' ? 'user' : null

  if (!ownerTypeQuery) {
    throw new Error(`Unsupported ownerType: ${ownerType}. Must be one of 'orgs' or 'users'`)
  }

  return ownerTypeQuery
}
