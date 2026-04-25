import { LightningElement, api, track } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { loadScript } from 'lightning/platformResourceLoader';
import PDFLib from '@salesforce/resourceUrl/pdflib';

import getCandidateDocuments from '@salesforce/apex/CandidateSubmissionController.getCandidateDocuments';
import getDocumentBase64Map from '@salesforce/apex/CandidateSubmissionController.getDocumentBase64Map';
import uploadFile from '@salesforce/apex/CandidateSubmissionController.uploadFile';
import createInlinePreviewAttachment from '@salesforce/apex/CandidateSubmissionController.createInlinePreviewAttachment';

export default class CandidateSubmissionStageReview extends LightningElement {
    _candidateId;
    _jobApplicantId;
    _documents = {};
    _preSelectedResumeId;
    _preSelectedResumeName;
    _isConnected = false;

    @track candidateDocuments = [];
    @track isReviewDetailsCollapsed = false;
    @track mergedPdfPreviewUrl = null;
    @track mergedPdfAttachmentId = null;
    @track isMergingPdfs = false;
    @track mergePdfError = null;
    @track isCombineEnabled = false; // Default OFF: show individual files first for instant feedback

    // Carousel state
    @track individualPreviewUrls = {};
    @track isLoadingPreviews = false;
    @track carouselIndex = 0;

    customOrderIds = [];
    dragStartIndex = null;
    pdfLibInitialized = false;
    autoMergeDebounceId = null;
    pendingAutoMerge = false;
    lastAutoMergeSignature = null;
    autoMergeRetryCount = 0;

    // ─── @api properties ────────────────────────────────────────────────────

    @api
    get candidateId() {
        return this._candidateId;
    }
    set candidateId(value) {
        this._candidateId = value;
        if (this._isConnected) this.loadDocuments(); // Only reload after initial connect
    }

    @api
    get jobApplicantId() {
        return this._jobApplicantId;
    }
    set jobApplicantId(value) {
        this._jobApplicantId = value;
        if (this._isConnected) this.loadDocuments(); // Only reload after initial connect
    }

    // Draft persistence: Candidate_Submission__c record ID for storing generated files
    _submissionRecordId;
    @api
    get submissionRecordId() {
        return this._submissionRecordId;
    }
    set submissionRecordId(value) {
        this._submissionRecordId = value;
    }

    @api
    get documents() {
        return this._documents;
    }
    set documents(value) {
        this._documents = value ? { ...value } : {};
        // Don't trigger previews here — candidateDocuments may not be loaded yet.
        // loadDocuments() will trigger the correct action after data is ready.
        this._documentsPending = true;
        this.dispatchMergedChange();
    }

    @api
    get preSelectedResumeId() {
        return this._preSelectedResumeId;
    }
    set preSelectedResumeId(value) {
        this._preSelectedResumeId = value;
    }

    @api
    get preSelectedResumeName() {
        return this._preSelectedResumeName;
    }
    set preSelectedResumeName(value) {
        this._preSelectedResumeName = value;
    }

    // ─── Lifecycle ───────────────────────────────────────────────────────────

    connectedCallback() {
        this._isConnected = true;
        this.loadDocuments();
    }

    // Load candidate documents to resolve metadata for selected file IDs
    async loadDocuments() {
        if (!this._candidateId) {
            this.candidateDocuments = [];
            return;
        }
        try {
            this.candidateDocuments = await getCandidateDocuments({
                candidateId: this._candidateId,
                jobApplicantId: this._jobApplicantId,
                submissionId: this._submissionRecordId || null // Include generated files on submission
            });
        } catch (error) {
            console.error('[Review] loadDocuments error:', error);
            this.candidateDocuments = [];
        }

        // Now that docs are loaded, trigger the correct preview mode
        if (this._documentsPending || Object.keys(this._documents || {}).length > 0) {
            this._documentsPending = false;
            if (this.isCombineEnabled) {
                this.queueAutoMerge();
            } else {
                this.loadIndividualPreviews();
            }
        }
    }

    renderedCallback() {
        if (!this.pdfLibInitialized) {
            this.pdfLibInitialized = true;
            loadScript(this, PDFLib).catch(() => {
                this.showToast('Error', 'Failed to load PDF library.', 'error');
            });
        }
    }

    disconnectedCallback() {
        if (this.autoMergeDebounceId) clearTimeout(this.autoMergeDebounceId);
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    @api
    async validateForSubmit() {
        if (this.isCombineEnabled && this.nonPdfSelectedFiles.length > 0) {
            const names = this.nonPdfSelectedFiles.map((f) => `${f.title}.${f.extension}`).join(', ');
            return {
                ok: false,
                errorMessage: `Only PDFs can be merged. Please replace: ${names}`
            };
        }

        // FIX: When combine is OFF, validate that we have at least one document
        if (!this.isCombineEnabled) {
            const individualDocIds = this._buildIndividualDocIds();
            console.log('[Review] validateForSubmit (combine OFF) — individualDocIds:', JSON.stringify(individualDocIds));
            if (individualDocIds.length === 0) {
                return {
                    ok: false,
                    errorMessage: 'No documents selected for submission.'
                };
            }
        }

        return { ok: true };
    }

    @api
    refreshDocuments() {
        return this.loadDocuments();
    }

    /**
     * Called by parent immediately before submit.
     * Reads directly from _documents map — does NOT depend on candidateDocuments
     * having loaded, so it is always accurate regardless of timing.
     */
    @api
    getMergedChangeDetail() {
        const individualDocIds = this._buildIndividualDocIds();
        console.log('[Review] getMergedChangeDetail — isCombineEnabled:', this.isCombineEnabled);
        console.log('[Review] getMergedChangeDetail — individualDocIds:', JSON.stringify(individualDocIds));
        console.log('[Review] getMergedChangeDetail — mergedPdfAttachmentId:', this.mergedPdfAttachmentId);
        return {
            mergedPdfAttachmentId: this.isCombineEnabled ? this.mergedPdfAttachmentId : null,
            isCombineEnabled: this.isCombineEnabled,
            // FIX: always pass the real IDs regardless of isCombineEnabled
            // so the parent always has them as a fallback
            individualDocIds: individualDocIds
        };
    }

    /**
     * FIX: Build individualDocIds from _documents map including ALL stage keys.
     * This is the canonical source of truth for which docs are selected.
     */
    _buildIndividualDocIds() {
        const d = this._documents || {};

        // All possible stage doc keys in natural order
        const naturalOrder = [
            d.Resume,
            d.References,
            d.BLS_Card,
            d.ACLS_Card,
          
            d.Credentials
        ].filter(Boolean);

        // If user dragged to reorder, respect that order
        if (this.customOrderIds && this.customOrderIds.length > 0) {
            const validSet = new Set(naturalOrder);
            const ordered = this.customOrderIds.filter(id => validSet.has(id));
            // append any that aren't in customOrderIds yet
            naturalOrder.forEach(id => {
                if (!ordered.includes(id)) ordered.push(id);
            });
            console.log('[Review] _buildIndividualDocIds (custom order):', JSON.stringify(ordered));
            return ordered;
        }

        console.log('[Review] _buildIndividualDocIds (natural order):', JSON.stringify(naturalOrder));
        return naturalOrder;
    }

    // ─── Getters ─────────────────────────────────────────────────────────────

    get reviewGridClass() {
        return this.isReviewDetailsCollapsed
            ? 'cs-review-grid cs-review-grid--expanded'
            : 'cs-review-grid cs-review-grid--split';
    }

    get reviewCollapseButtonIcon() {
        return this.isReviewDetailsCollapsed ? 'utility:contract_alt' : 'utility:expand_alt';
    }

    get reviewCollapseButtonTitle() {
        return this.isReviewDetailsCollapsed
            ? 'Restore Stage Completeness View'
            : 'Maximize Final Preview';
    }

    get combineToggleTooltip() {
        return this.isCombineEnabled
            ? 'PDFs will be merged into one combined file'
            : 'Each PDF will be attached as a separate file';
    }

    get documentsListLabel() {
        return this.isCombineEnabled
            ? 'Documents in Final PDF (Drag to Rearrange)'
            : 'Documents (Will Attach Separately)';
    }

    get reviewStagesList() {
        const d = this._documents || {};
        return [
            { id: 1, name: 'Resume',           completed: !!d.Resume },
            { id: 2, name: 'References',        completed: !!d.References },
            { id: 3, name: 'BLS Card',          completed: !!d.BLS_Card },
            { id: 4, name: 'ACLS Card',         completed: !!d.ACLS_Card },
            { id: 5, name: 'Credentials',       completed: !!d.Credentials }
        ].map((stage) => ({
            ...stage,
            iconName:    stage.completed ? 'utility:check' : 'utility:dash',
            iconVariant: stage.completed ? 'success' : 'error',
            statusLabel: stage.completed ? 'Included' : 'Skipped',
            statusClass: stage.completed ? 'cs-status cs-status--success' : 'cs-status cs-status--missing',
            rowClass:    stage.completed ? 'cs-check-row cs-check-row--done' : 'cs-check-row cs-check-row--missing'
        }));
    }

    get selectedFilesForReview() {
        const d = this._documents || {};

        // FIX: Include ALL stage keys including Skills_Checklist
        const naturalIds = [];
        if (d.Resume)           naturalIds.push(d.Resume);
        if (d.References)       naturalIds.push(d.References);
        if (d.BLS_Card)         naturalIds.push(d.BLS_Card);
        if (d.ACLS_Card)        naturalIds.push(d.ACLS_Card);
       
        if (d.Credentials)      naturalIds.push(d.Credentials);

        const fromList = (this.candidateDocuments || []).filter(
            (doc) => naturalIds.includes(doc.contentDocumentId)
        );

        // Inject pre-selected resume if not found in candidate docs
        const resumeId = d.Resume;
        if (
            resumeId &&
            this._preSelectedResumeId &&
            resumeId === this._preSelectedResumeId &&
            !fromList.find((fd) => fd.contentDocumentId === resumeId)
        ) {
            fromList.push({
                contentDocumentId: resumeId,
                title: (this._preSelectedResumeName || 'Resume').replace(/\.pdf$/i, ''),
                extension: 'pdf',
                sourceType: 'File'
            });
        }

        const orderSource =
            this.customOrderIds && this.customOrderIds.length > 0
                ? this.customOrderIds
                : naturalIds;

        fromList.sort((a, b) => {
            const ia = orderSource.indexOf(a.contentDocumentId);
            const ib = orderSource.indexOf(b.contentDocumentId);
            if (ia !== -1 && ib !== -1) return ia - ib;
            if (ia !== -1) return -1;
            if (ib !== -1) return 1;
            return 0;
        });

        return fromList;
    }

    get nonPdfSelectedFiles() {
        return this.selectedFilesForReview.filter(
            (doc) => !doc?.extension || doc.extension.toLowerCase() !== 'pdf'
        );
    }

    // ─── Carousel getters ─────────────────────────────────────────────────────

    get selectedFilesWithPreview() {
        return this.selectedFilesForReview.map((doc) => ({
            ...doc,
            previewUrl: this.individualPreviewUrls[doc.contentDocumentId] || null
        }));
    }

    get currentCarouselFile() {
        const files = this.selectedFilesWithPreview;
        if (!files || files.length === 0) return { title: '', extension: '', previewUrl: null };
        const safeIndex = Math.min(this.carouselIndex, files.length - 1);
        return files[safeIndex] || files[0];
    }

    get carouselCounterLabel() {
        const total = this.selectedFilesForReview.length;
        if (total === 0) return '';
        const safeIndex = Math.min(this.carouselIndex, total - 1);
        return `${safeIndex + 1} / ${total}`;
    }

    get isCarouselAtStart() {
        return this.carouselIndex <= 0;
    }

    get isCarouselAtEnd() {
        return this.carouselIndex >= this.selectedFilesForReview.length - 1;
    }

    get carouselDots() {
        return this.selectedFilesForReview.map((_, idx) => ({
            index: idx,
            dotClass: idx === this.carouselIndex ? 'cs-carousel-dot cs-carousel-dot--active' : 'cs-carousel-dot'
        }));
    }

    // ─── Handlers ────────────────────────────────────────────────────────────

    handleToggleReviewDetails() {
        this.isReviewDetailsCollapsed = !this.isReviewDetailsCollapsed;
    }

    handleCombineToggle(event) {
        this.isCombineEnabled = event.target.checked;

        console.log('[Review] handleCombineToggle — isCombineEnabled:', this.isCombineEnabled);
        console.log('[Review] handleCombineToggle — _documents:', JSON.stringify(this._documents));
        console.log('[Review] handleCombineToggle — _buildIndividualDocIds:', JSON.stringify(this._buildIndividualDocIds()));

        if (this.isCombineEnabled) {
            this.lastAutoMergeSignature = null;
            this.mergedPdfPreviewUrl = null;
            this.mergedPdfAttachmentId = null;
            this.mergePdfError = null;
            this.individualPreviewUrls = {};
            this.carouselIndex = 0;
            this.queueAutoMerge();
        } else {
            this.mergedPdfPreviewUrl = null;
            this.mergedPdfAttachmentId = null;
            this.mergePdfError = null;
            this.carouselIndex = 0;
            // FIX: dispatch BEFORE loading previews so parent state is updated immediately
            this.dispatchMergedChange();
            this.loadIndividualPreviews();
        }
    }

    handleCarouselPrev() {
        if (this.carouselIndex > 0) {
            this.carouselIndex -= 1;
        }
    }

    handleCarouselNext() {
        if (this.carouselIndex < this.selectedFilesForReview.length - 1) {
            this.carouselIndex += 1;
        }
    }

    handleDotClick(event) {
        const idx = Number(event.currentTarget.dataset.index);
        if (!isNaN(idx)) {
            this.carouselIndex = idx;
        }
    }

    handleDragStart(event) {
        this.dragStartIndex = Number(event.currentTarget?.dataset?.index);
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', String(this.dragStartIndex));
        }
    }

    handleDragOver(event) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }

    handleDrop(event) {
        event.preventDefault();
        const toIndex   = Number(event.currentTarget?.dataset?.index);
        const fromIndex = this.dragStartIndex;
        if (
            !Number.isInteger(fromIndex) ||
            !Number.isInteger(toIndex) ||
            fromIndex === toIndex
        ) return;

        const docs = [...this.selectedFilesForReview];
        if (
            fromIndex < 0 || toIndex < 0 ||
            fromIndex >= docs.length || toIndex >= docs.length
        ) return;

        const [item] = docs.splice(fromIndex, 1);
        docs.splice(toIndex, 0, item);
        this.customOrderIds = docs.map((d) => d.contentDocumentId);
        this.queueAutoMerge(true);
        this.dragStartIndex = null;
    }

    // ─── Individual Previews ─────────────────────────────────────────────────

    async loadIndividualPreviews() {
        const files = this.selectedFilesForReview;
        if (!files || files.length === 0) return;

        this.isLoadingPreviews = true;
        const urlMap = {};

        for (const doc of files) {
            try {
                const attachmentId = await createInlinePreviewAttachment({
                    sourceDocId: doc.contentDocumentId,
                    recordId: this._submissionRecordId || this._candidateId // Draft persistence
                });
                if (attachmentId) {
                    urlMap[doc.contentDocumentId] = `/servlet/servlet.FileDownload?file=${attachmentId}`;
                }
            } catch (e) {
                console.warn(`Could not load preview for ${doc.title}:`, e);
            }
        }

        this.individualPreviewUrls = { ...urlMap };
        this.isLoadingPreviews = false;
    }

    // ─── Auto-merge ──────────────────────────────────────────────────────────

    getReviewSelectionSignature() {
        return (this.selectedFilesForReview || [])
            .map((d) => d.contentDocumentId)
            .join('|');
    }

    queueAutoMerge(force = false) {
        if (!this.isCombineEnabled) return;

        const signature = this.getReviewSelectionSignature();
        if (!signature) {
            this.mergePdfError = null;
            this.mergedPdfPreviewUrl = null;
            this.mergedPdfAttachmentId = null;
            this.lastAutoMergeSignature = null;
            this.dispatchMergedChange();
            return;
        }
        if (this.nonPdfSelectedFiles.length > 0) {
            const names = this.nonPdfSelectedFiles
                .map((f) => `${f.title}.${f.extension}`)
                .join(', ');
            this.mergePdfError = `Only PDFs can be merged. Please replace: ${names}`;
            this.mergedPdfPreviewUrl = null;
            this.mergedPdfAttachmentId = null;
            this.lastAutoMergeSignature = null;
            this.dispatchMergedChange();
            return;
        }
        if (!force && this.lastAutoMergeSignature === signature && this.mergedPdfPreviewUrl) return;
        if (this.isMergingPdfs) {
            this.pendingAutoMerge = true;
            return;
        }
        if (this.autoMergeDebounceId) clearTimeout(this.autoMergeDebounceId);
        this.autoMergeDebounceId = setTimeout(() => {
            this.autoMergeDebounceId = null;
            this.runAutoMerge(signature);
        }, 250);
    }

    async runAutoMerge(expectedSignature) {
        const currentSignature = this.getReviewSelectionSignature();
        if (!currentSignature || expectedSignature !== currentSignature) {
            this.queueAutoMerge();
            return;
        }
        await this.handleGenerateMergedPdf({ silentInfoToast: true, silentErrorToast: true });
        if (this.mergedPdfPreviewUrl) {
            this.lastAutoMergeSignature = currentSignature;
            this.autoMergeRetryCount = 0;
        } else if (
            this.mergePdfError &&
            this.mergePdfError.toLowerCase().includes('loading') &&
            this.autoMergeRetryCount < 5
        ) {
            this.autoMergeRetryCount += 1;
            setTimeout(() => this.queueAutoMerge(), 700);
        }
        if (this.pendingAutoMerge) {
            this.pendingAutoMerge = false;
            this.queueAutoMerge();
        }
    }

    async handleGenerateMergedPdf(options = {}) {
        const opts             = options || {};
        const silentInfoToast  = !!opts.silentInfoToast;
        const silentErrorToast = !!opts.silentErrorToast;

        if (!this.selectedFilesForReview || this.selectedFilesForReview.length === 0) {
            if (!silentInfoToast) this.showToast('Info', 'No files selected for merge.', 'info');
            return;
        }
        if (this.nonPdfSelectedFiles.length > 0) {
            const names = this.nonPdfSelectedFiles
                .map((f) => `${f.title}.${f.extension}`)
                .join(', ');
            this.mergePdfError = `Only PDFs can be merged. Please replace: ${names}`;
            if (!silentErrorToast)
                this.showToast('PDF Required', this.mergePdfError, 'error');
            return;
        }

        this.isMergingPdfs         = true;
        this.mergePdfError         = null;
        this.mergedPdfPreviewUrl   = null;
        this.mergedPdfAttachmentId = null;

        try {
            const docIds = this.selectedFilesForReview.map((d) => d.contentDocumentId);
            if (!window.PDFLib && !globalThis.PDFLib)
                throw new Error('PDF library is still loading. Please try again.');

            const base64Map = await getDocumentBase64Map({ docIds });
            if (!base64Map || Object.keys(base64Map).length === 0)
                throw new Error('Could not fetch selected PDFs.');

            const { PDFDocument, rgb, StandardFonts } =
                window.PDFLib || globalThis.PDFLib;

            const mergedPdf      = await PDFDocument.create();
            const helveticaFont  = await mergedPdf.embedFont(StandardFonts.HelveticaBold);

            let pageCount = 0;
            for (const docId of docIds) {
                const b64 = base64Map[docId];
                if (!b64) continue;

                const pdfBytes  = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
                const pdf       = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
                const pages     = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
                const stageName = this.getStageNameForDocId(docId);

                pages.forEach((p, index) => {
                    const { width, height } = p.getSize();
                    const headerHeight      = 35;
                    const newHeight         = height + headerHeight;
                    p.setSize(width, newHeight);

                    p.drawRectangle({
                        x: 0, y: height,
                        width, height: headerHeight,
                        color: rgb(0.95, 0.97, 1), opacity: 1
                    });

                    p.drawLine({
                        start: { x: 0, y: height },
                        end:   { x: width, y: height },
                        thickness: 1.5,
                        color: rgb(0.8, 0.85, 0.9)
                    });

                    p.drawText(`DOCUMENT: ${stageName.toUpperCase()}`, {
                        x: 24, y: height + 12,
                        size: 10, font: helveticaFont,
                        color: rgb(0.2, 0.3, 0.45)
                    });

                    const pageInfo  = `Page ${index + 1} of ${pages.length}`;
                    const textWidth = helveticaFont.widthOfTextAtSize(pageInfo, 9);
                    p.drawText(pageInfo, {
                        x: width - 24 - textWidth, y: height + 12,
                        size: 9, font: helveticaFont,
                        color: rgb(0.45, 0.55, 0.65)
                    });

                    mergedPdf.addPage(p);
                });

                pageCount += pages.length;
            }

            if (pageCount === 0) throw new Error('No valid PDF pages found to merge.');

            const mergedBase64       = await mergedPdf.saveAsBase64({ dataUri: false });
            const fileName           = `Merged_${docIds.length}PDFs_${Date.now()}.pdf`;
            const mergedAttachmentId = await uploadFile({
                base64Data:  mergedBase64,
                filename:    fileName,
                contentType: 'application/pdf',
                recordId:    this._submissionRecordId || this._candidateId // Draft persistence: upload to submission
            });

            if (!mergedAttachmentId)
                throw new Error('Merged PDF was created but could not be saved.');

            this.mergedPdfAttachmentId  = mergedAttachmentId;
            this.mergedPdfPreviewUrl    = `/servlet/servlet.FileDownload?file=${mergedAttachmentId}`;
            this.lastAutoMergeSignature = docIds.join('|');

            this.dispatchMergedChange();
            this.dispatchEvent(new CustomEvent('documentsrefresh'));
            this.loadDocuments();
        } catch (error) {
            this.mergePdfError = this.getErrorMessage(error);
            if (!silentErrorToast)
                this.showToast('Error', `Failed to merge PDFs: ${this.mergePdfError}`, 'error');
        } finally {
            this.isMergingPdfs = false;
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    loadDocuments() {
        if (!this._candidateId) {
            this.candidateDocuments = [];
            return Promise.resolve();
        }
        return getCandidateDocuments({
            candidateId:    this._candidateId,
            jobApplicantId: this._jobApplicantId,
            submissionId:   this._submissionRecordId || null // Draft persistence: include submission files
        })
            .then((result) => {
                this.candidateDocuments = result || [];
                if (!this.isCombineEnabled) {
                    this.dispatchMergedChange();
                    this.loadIndividualPreviews();
                } else {
                    this.queueAutoMerge();
                }
            })
            .catch((err) => {
                this.showToast(
                    'Error',
                    `Failed to load review documents. ${this.getErrorMessage(err)}`,
                    'error'
                );
            });
    }

    getStageNameForDocId(docId) {
        const d = this._documents || {};
        if (d.Resume           === docId) return 'Resume';
        if (d.References       === docId) return 'References';
        if (d.BLS_Card         === docId) return 'BLS Card';
        if (d.ACLS_Card        === docId) return 'ACLS Card';
        if (d.Skills_Checklist === docId) return 'Skills Checklist';
        if (d.Credentials      === docId) return 'Credentials';
        return 'Attachment';
    }

    dispatchMergedChange() {
        const individualDocIds = this._buildIndividualDocIds();

        console.log('[Review] dispatchMergedChange — isCombineEnabled:', this.isCombineEnabled);
        console.log('[Review] dispatchMergedChange — individualDocIds:', JSON.stringify(individualDocIds));
        console.log('[Review] dispatchMergedChange — mergedPdfAttachmentId:', this.mergedPdfAttachmentId);

        this.dispatchEvent(
            new CustomEvent('mergedchange', {
                detail: {
                    mergedPdfAttachmentId: this.isCombineEnabled
                        ? this.mergedPdfAttachmentId
                        : null,
                    isCombineEnabled: this.isCombineEnabled,
                    // FIX: always send individualDocIds so parent always has them
                    individualDocIds: individualDocIds
                }
            })
        );
    }

    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }

    getErrorMessage(error) {
        if (Array.isArray(error?.body))
            return error.body.map((e) => e.message).join(', ');
        if (typeof error?.body?.message === 'string') return error.body.message;
        if (typeof error?.message === 'string')       return error.message;
        return 'Unknown error';
    }
}