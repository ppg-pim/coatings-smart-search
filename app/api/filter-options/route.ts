import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Helper function to extract filter values from coatings
function extractFilterOptions(coatings: any[]) {
  const families = new Set<string>()
  const productTypes = new Set<string>()
  const productModels = new Set<string>()

  coatings?.forEach((coating: any) => {
    // Extract family
    const familyValue = coating.family || coating.Family || coating.product_family || coating.productFamily
    if (familyValue && String(familyValue).trim()) {
      families.add(String(familyValue).trim())
    }

    // Extract product type
    const typeValue = coating.product_type || coating.productType || coating.type || coating.Type || coating.category || coating.Category
    if (typeValue && String(typeValue).trim()) {
      productTypes.add(String(typeValue).trim())
    }

    // Extract product model
    const modelValue = coating.product_model || coating.productModel || coating.model || coating.Model
    if (modelValue && String(modelValue).trim()) {
      productModels.add(String(modelValue).trim())
    }

    // Also check in all_attributes
    if (coating.all_attributes) {
      try {
        let attributes: any = typeof coating.all_attributes === 'string' 
          ? JSON.parse(coating.all_attributes) 
          : coating.all_attributes

        const attrFamily = attributes.family || attributes.Family || attributes.product_family || attributes.productFamily
        if (attrFamily && String(attrFamily).trim()) {
          families.add(String(attrFamily).trim())
        }

        const attrType = attributes.product_type || attributes.productType || attributes.type || attributes.Type
        if (attrType && String(attrType).trim()) {
          productTypes.add(String(attrType).trim())
        }

        const attrModel = attributes.product_model || attributes.productModel || attributes.model || attributes.Model
        if (attrModel && String(attrModel).trim()) {
          productModels.add(String(attrModel).trim())
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }
  })

  return {
    families: Array.from(families).sort(),
    productTypes: Array.from(productTypes).sort(),
    productModels: Array.from(productModels).sort()
  }
}

// Helper function to apply filters to query
function applyFiltersToQuery(query: any, filters: any) {
  if (!filters) return query

  // Apply family filter
  if (filters.family) {
    const familyColumns = ['family', 'Family', 'product_family', 'productFamily']
    const orConditions = familyColumns.map(col => `${col}.eq.${filters.family}`).join(',')
    query = query.or(orConditions)
  }

  // Apply product type filter
  if (filters.productType) {
    const typeColumns = ['product_type', 'productType', 'type', 'Type', 'category', 'Category']
    const orConditions = typeColumns.map(col => `${col}.eq.${filters.productType}`).join(',')
    query = query.or(orConditions)
  }

  // Apply product model filter
  if (filters.productModel) {
    const modelColumns = ['product_model', 'productModel', 'model', 'Model']
    const orConditions = modelColumns.map(col => `${col}.eq.${filters.productModel}`).join(',')
    query = query.or(orConditions)
  }

  return query
}

// Helper to filter in memory (fallback)
function filterInMemory(coatings: any[], filters: any) {
  if (!filters) return coatings

  return coatings.filter(coating => {
    // Check family
    if (filters.family) {
      const familyValue = coating.family || coating.Family || coating.product_family || coating.productFamily
      const attrFamily = coating.all_attributes?.family || coating.all_attributes?.Family
      
      if (familyValue !== filters.family && attrFamily !== filters.family) {
        return false
      }
    }

    // Check product type
    if (filters.productType) {
      const typeValue = coating.product_type || coating.productType || coating.type || coating.Type || coating.category || coating.Category
      const attrType = coating.all_attributes?.product_type || coating.all_attributes?.type
      
      if (typeValue !== filters.productType && attrType !== filters.productType) {
        return false
      }
    }

    // Check product model
    if (filters.productModel) {
      const modelValue = coating.product_model || coating.productModel || coating.model || coating.Model
      const attrModel = coating.all_attributes?.product_model || coating.all_attributes?.model
      
      if (modelValue !== filters.productModel && attrModel !== filters.productModel) {
        return false
      }
    }

    return true
  })
}

// POST handler - with dynamic filtering based on current selections
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { currentFilters } = body

    console.log('📋 Loading filter options with current filters:', currentFilters)

    // Fetch all coatings
    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(10000)

    if (error) {
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${coatings?.length || 0} coatings`)

    // Apply filters in memory to get relevant subset
    const filteredCoatings = filterInMemory(coatings || [], currentFilters)
    
    console.log(`🔍 After filtering: ${filteredCoatings.length} coatings`)

    // Extract filter options from filtered data
    const { families, productTypes, productModels } = extractFilterOptions(filteredCoatings)

    console.log(`✅ Found ${families.length} families, ${productTypes.length} product types, ${productModels.length} product models`)

    return NextResponse.json({
      success: true,
      families,
      productTypes,
      productModels,
      totalCoatings: filteredCoatings.length
    })

  } catch (error: any) {
    console.error('❌ Filter options error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Failed to load filter options',
        families: [],
        productTypes: [],
        productModels: [],
        totalCoatings: 0
      },
      { status: 500 }
    )
  }
}

// GET handler - initial load without filters
export async function GET() {
  try {
    console.log('📋 Loading initial filter options...')

    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(10000)

    if (error) {
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${coatings?.length || 0} coatings`)

    // Extract filter options
    const { families, productTypes, productModels } = extractFilterOptions(coatings || [])

    console.log(`✅ Found ${families.length} families, ${productTypes.length} product types, ${productModels.length} product models`)

    return NextResponse.json({
      success: true,
      families,
      productTypes,
      productModels,
      totalCoatings: coatings?.length || 0
    })

  } catch (error: any) {
    console.error('❌ Filter options error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Failed to load filter options',
        families: [],
        productTypes: [],
        productModels: [],
        totalCoatings: 0
      },
      { status: 500 }
    )
  }
}
