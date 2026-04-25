import { LightningElement, api } from 'lwc';

export default class CandidateSubmissionStageAclsCard extends LightningElement {
	@api candidateId;
	@api jobApplicantId;
	@api submissionRecordId; // Draft persistence: passed through to file requirement
	@api selectedDocumentId;
	@api excludedDocumentIds = [];
	@api stageKey;             // e.g., 'BLS_Card'
	handleSelectionChange(event) {
		this.dispatchEvent(new CustomEvent('selectionchange', {
			detail: event.detail
		}));
	}

	handleDocumentsRefresh() {
		this.dispatchEvent(new CustomEvent('documentsrefresh'));
	}
	handleFileSelection(event) {
    const newlySelectedId = event.currentTarget.dataset.id; // Or however you get the ID

    // Fire this exact event so the parent catches it
    this.dispatchEvent(new CustomEvent('selectionchange', {
        detail: {
            stageKey: this.stageKey,
            selectedDocumentId: newlySelectedId
        }
    }));
}
}