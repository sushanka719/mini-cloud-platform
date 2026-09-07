import { deploymentRepo, type DeploymentRow } from '@forge/db';
import type { WsTopic } from '@forge/shared';
import type { Actor } from '../plugins/auth.js';
import { findMembership } from '../repositories/org-repository.js';
import { findProjectOrg } from '../repositories/project-repository.js';

/**
 * Who may listen to what.
 *
 * A topic is a Redis channel name, and a channel carries another tenant's
 * build logs — so subscribing has to run the same RBAC check as the REST route
 * that returns the same data, not merely "are you logged in".
 *
 * The pattern mirrors `requireOrg`: resolve the topic to an org, then verify
 * membership. A topic the caller may not see is reported as *unknown* rather
 * than forbidden, so probing ids can't be used to enumerate other orgs'
 * deployments (the same reason `requireOrg` answers 404).
 */

export type TopicDecision =
  | {
      ok: true;
      orgId: string | null;
      /**
       * The deployment a `deployment:<id>` topic resolved to. Carried through
       * so the replay step doesn't re-read the row we just fetched to
       * authorize the subscription.
       */
      deployment?: DeploymentRow;
    }
  | { ok: false; code: 'UNKNOWN_TOPIC' | 'TOPIC_FORBIDDEN'; message: string };

const UNKNOWN: TopicDecision = {
  ok: false,
  code: 'UNKNOWN_TOPIC',
  message: 'No such topic',
};

/** Membership in one org, for either credential kind. */
async function canReadOrg(actor: Actor, orgId: string): Promise<boolean> {
  // An API key is bound to exactly one org and cannot reach across tenants.
  if (actor.via === 'api_key') return actor.orgId === orgId;
  return (await findMembership(orgId, actor.user.id)) !== undefined;
}

export async function authorizeTopic(actor: Actor, topic: WsTopic): Promise<TopicDecision> {
  switch (topic.kind) {
    case 'metrics':
      // Process/queue metrics are infrastructure-wide, like GET …/fleet: any
      // authenticated member may watch them. Phase 9 supplies the publisher.
      return { ok: true, orgId: null };

    case 'org':
      return (await canReadOrg(actor, topic.id)) ? { ok: true, orgId: topic.id } : UNKNOWN;

    case 'project': {
      const project = await findProjectOrg(topic.id);
      if (!project) return UNKNOWN;
      return (await canReadOrg(actor, project.org_id))
        ? { ok: true, orgId: project.org_id }
        : UNKNOWN;
    }

    case 'deployment': {
      const deployment = await deploymentRepo.findDeploymentById(topic.id);
      if (!deployment) return UNKNOWN;
      return (await canReadOrg(actor, deployment.org_id))
        ? { ok: true, orgId: deployment.org_id, deployment }
        : UNKNOWN;
    }
  }
}
